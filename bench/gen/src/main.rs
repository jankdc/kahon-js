//! Streaming generator for kahon-js benchmark fixtures.
//!
//! Produces a single big-object with N keys named `key_00000000`, `key_00000001`,
//! ... where each value is a string of `--value-bytes` bytes. Output is written
//! incrementally via the kahon Writer, so peak RAM is bounded by the writer's
//! internal buffering (independent of N).

use std::fs::File;
use std::io::BufWriter;
use std::process::ExitCode;

use kahon::Writer;

struct Args {
    keys: usize,
    value_bytes: usize,
    out: String,
}

fn parse_args() -> Result<Args, String> {
    let mut keys: Option<usize> = None;
    let mut value_bytes: usize = 64;
    let mut out: Option<String> = None;

    let mut it = std::env::args().skip(1);
    while let Some(a) = it.next() {
        match a.as_str() {
            "--keys" => {
                keys = Some(
                    it.next()
                        .ok_or("--keys requires a value")?
                        .parse()
                        .map_err(|e| format!("--keys: {e}"))?,
                )
            }
            "--value-bytes" => {
                value_bytes = it
                    .next()
                    .ok_or("--value-bytes requires a value")?
                    .parse()
                    .map_err(|e| format!("--value-bytes: {e}"))?
            }
            "--out" => out = Some(it.next().ok_or("--out requires a value")?),
            "-h" | "--help" => {
                eprintln!(
                    "usage: bench-gen --keys N --out PATH [--value-bytes B]\n\
                     \n\
                     Writes a kahon-encoded big-object with N keys (key_00000000..)\n\
                     where each value is a string of B bytes (default 64)."
                );
                std::process::exit(0);
            }
            other => return Err(format!("unknown arg: {other}")),
        }
    }

    Ok(Args {
        keys: keys.ok_or("--keys is required")?,
        value_bytes,
        out: out.ok_or("--out is required")?,
    })
}

fn run(args: Args) -> std::io::Result<()> {
    let f = File::create(&args.out)?;
    let mut bw = BufWriter::with_capacity(1 << 20, f);

    // Pre-build the value template once; mutate the prefix for uniqueness.
    let mut value = vec![b'x'; args.value_bytes];

    {
        let mut w = Writer::new(&mut bw);
        let mut obj = w.start_object();

        for i in 0..args.keys {
            // Stamp i into the first bytes of the value so it isn't fully
            // compressible / identical (small but enough to defeat any naive
            // dedup the LRU might otherwise benefit from).
            let stamp = format!("{i:016x}");
            let n = stamp.len().min(value.len());
            value[..n].copy_from_slice(&stamp.as_bytes()[..n]);

            let key = format!("key_{i:08}");
            // SAFETY of cast: value is built from b'x' + ASCII hex digits.
            let s = std::str::from_utf8(&value).unwrap();
            obj.push_str(&key, s)
                .map_err(|e| std::io::Error::other(format!("push_str: {e:?}")))?;
        }

        obj.end()
            .map_err(|e| std::io::Error::other(format!("end: {e:?}")))?;
        w.finish()
            .map_err(|e| std::io::Error::other(format!("finish: {e:?}")))?;
    }

    use std::io::Write as _;
    bw.flush()?;
    Ok(())
}

fn main() -> ExitCode {
    let args = match parse_args() {
        Ok(a) => a,
        Err(e) => {
            eprintln!("error: {e}");
            return ExitCode::from(2);
        }
    };
    if let Err(e) = run(args) {
        eprintln!("error: {e}");
        return ExitCode::from(1);
    }
    ExitCode::SUCCESS
}
