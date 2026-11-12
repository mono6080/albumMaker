// ── 相本命名慣例：模板名稱當前綴，老師只填自訂名稱（格式：分校-班級）──────────
// 建立相本改走「班級 × 期別工作格」之後，兩個建立表單都改成整串自己打，前綴因此掉了。
// 這裡把慣例收成單一來源，老師端與園所設定端共用。

// 與後端 ORGANIZATION_NAME_MAX_LENGTH 對齊：組好的全名超過就會被擋下來。
export const ALBUM_NAME_MAX_LENGTH = 100;

/**
 * 組出相本全名；沒選模板時就只有自訂名稱，沒填自訂名稱時就只有模板名稱。
 * 老師在自訂名稱又打了一次模板名稱時只留一份。
 * 後端 services/organization_service.py 的 compose_album_name 是同一套規則的鏡像
 * （伺服器建立時會再組一次），由 tests/test_album_name_prefix.py 與
 * tests/unit/album-name.test.mjs 釘住。
 */
export function composeAlbumName(templateName, customName) {
  const template = (templateName ?? "").trim();
  let custom = (customName ?? "").trim();
  if (!template) return custom;
  while (custom === template || custom.startsWith(`${template} `)) {
    custom = custom.slice(template.length).trim();
  }
  return custom ? `${template} ${custom}` : template;
}

/** 自訂名稱的預設值：分校-班級，直接符合慣例，老師要改也改得動。 */
export function buildDefaultCustomName(campusName, classroomName) {
  return [campusName, classroomName].filter(Boolean).join("-");
}

/** 自訂名稱還能填幾個字：全名（含前綴與分隔空格）不得超過上限。 */
export function customNameMaxLength(templateName) {
  const template = (templateName ?? "").trim();
  if (!template) return ALBUM_NAME_MAX_LENGTH;
  return Math.max(0, ALBUM_NAME_MAX_LENGTH - template.length - 1);
}
