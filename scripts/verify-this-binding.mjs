/**
 * Chứng minh vì sao API của ví PHẢI được gọi kèm `this`.
 *
 * Ví CIP-30 cài đặt API theo hai kiểu:
 *   - arrow function / đã bind  -> gọi rời vẫn chạy  (Eternl, Typhon…)
 *   - class method              -> gọi rời ném lỗi   (có thể là Lace)
 *
 * Code dò ví lấy hàm ra biến rồi gọi rời sẽ chỉ hỏng với kiểu thứ hai — và biểu
 * hiện y như "ví không trả về địa chỉ", rất dễ chẩn đoán sai.
 *
 * Chạy: node scripts/verify-this-binding.mjs
 */

let failures = 0;
function assert(label, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label} -> ${JSON.stringify(actual)}`);
}

/** Ví kiểu arrow function: không phụ thuộc `this`. */
const arrowStyleApi = (() => {
  const addresses = ["deadbeef"];
  return { getUsedAddresses: async () => addresses };
})();

/** Ví kiểu class method: phụ thuộc `this`. */
class ClassStyleApi {
  #addresses = ["cafebabe"];
  async getUsedAddresses() {
    return this.#addresses; // gọi rời -> `this` undefined -> ném lỗi
  }
}
const classStyleApi = new ClassStyleApi();

async function callDetached(api) {
  const fn = api.getUsedAddresses;
  try {
    return { ok: true, value: (await fn())[0] };
  } catch (err) {
    return { ok: false, error: err.constructor.name };
  }
}

async function callBound(api) {
  const fn = api.getUsedAddresses;
  try {
    return { ok: true, value: (await fn.call(api))[0] };
  } catch (err) {
    return { ok: false, error: err.constructor.name };
  }
}

console.log("--- Gọi rời (cách SAI) ---");
assert("ví arrow-style: vẫn chạy", (await callDetached(arrowStyleApi)).value, "deadbeef");
assert("ví class-style: HỎNG", (await callDetached(classStyleApi)).ok, false);

console.log("\n--- Gọi kèm .call(api) (cách ĐÚNG) ---");
assert("ví arrow-style: chạy", (await callBound(arrowStyleApi)).value, "deadbeef");
assert("ví class-style: chạy", (await callBound(classStyleApi)).value, "cafebabe");

console.log(
  `\n${failures === 0 ? "Tất cả kiểm tra đã pass." : `${failures} kiểm tra thất bại.`}`,
);
process.exit(failures === 0 ? 0 : 1);
