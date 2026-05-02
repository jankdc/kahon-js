export const HEADER_SIZE = 6;
export const TRAILER_SIZE = 12;
export const MAGIC_BYTES = Buffer.from("KAHN", "ascii");
export const VERSION = 0x01;

export const T_NULL = 0x00;
export const T_FALSE = 0x01;
export const T_TRUE = 0x02;

export const T_TINY_NEG_INT_MIN = 0x03;
export const T_TINY_NEG_INT_MAX = 0x12;
export const T_TINY_UINT_MIN = 0x13;
export const T_TINY_UINT_MAX = 0x32;

export const T_EMPTY_ARRAY = 0x33;
export const T_EMPTY_OBJECT = 0x34;

export const T_UINT8 = 0x40;
export const T_UINT16 = 0x41;
export const T_UINT32 = 0x42;
export const T_UINT64 = 0x43;
export const T_INT8 = 0x44;
export const T_INT16 = 0x45;
export const T_INT32 = 0x46;
export const T_INT64 = 0x47;

export const T_FLOAT32 = 0x50;
export const T_FLOAT64 = 0x51;

export const T_TINY_STRING_MIN = 0x60;
export const T_TINY_STRING_MAX = 0x6e;
export const T_STRING = 0x6f;

export const T_ARRAY_LEAF_MIN = 0x70;
export const T_ARRAY_LEAF_MAX = 0x73;
export const T_ARRAY_INTERNAL_MIN = 0x74;
export const T_ARRAY_INTERNAL_MAX = 0x77;

export const T_OBJECT_LEAF_MIN = 0x80;
export const T_OBJECT_LEAF_MAX = 0x83;
export const T_OBJECT_INTERNAL_MIN = 0x84;
export const T_OBJECT_INTERNAL_MAX = 0x87;

export type OffsetWidth = 1 | 2 | 4 | 8;

export function widthFromCode(code: number): OffsetWidth {
  const w = code & 0x03;
  return (w === 0 ? 1 : w === 1 ? 2 : w === 2 ? 4 : 8) as OffsetWidth;
}
