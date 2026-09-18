/** 同一 bundle 内 block/span id 统一分配，避免分支合并后重复。 */
export type BundleIds = {
  nextBlockId: () => string;
  nextSpanId: () => string;
};

export function createBundleIds(documentVersionId: string): BundleIds {
  let blockSeq = 0;
  let spanSeq = 0;
  return {
    nextBlockId: () => `${documentVersionId}-blk-${String(++blockSeq).padStart(2, "0")}`,
    nextSpanId: () => `${documentVersionId}-span-${String(++spanSeq).padStart(2, "0")}`,
  };
}
