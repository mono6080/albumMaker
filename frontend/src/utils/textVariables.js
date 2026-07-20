import { MAX_LABEL_TEXT_LENGTH } from "../constants/textContent.js";

// 鏡像 backend/services/text_variables.py；前後端都依 raw／replacement／final 順序截斷。
export const NAME_VARIABLE = "{name}";
export const FULL_NAME_VARIABLE = "{full_name}";
export const ALBUM_NAME_PREVIEW_PLACEHOLDER = "（相本稱呼）";
export const FULL_NAME_PREVIEW_PLACEHOLDER = "（完整姓名）";

export const STUDENT_NAME_VARIABLES = [
  {
    token: NAME_VARIABLE,
    label: "相本稱呼",
    description: "使用園所設定的相本稱呼，未設定時使用完整姓名",
  },
  {
    token: FULL_NAME_VARIABLE,
    label: "完整姓名",
    description: "固定使用本期學生快照中的完整姓名",
  },
];

function replaceAllText(sourceText, token, replacement) {
  return sourceText.split(token).join(replacement);
}

function normalizeTextVariableValue(value) {
  return typeof value === "string"
    ? [...value].slice(0, MAX_LABEL_TEXT_LENGTH).join("")
    : "";
}

export function resolveStudentNameVariables(value, fullName, albumName = null) {
  const sourceText = normalizeTextVariableValue(value);
  const safeFullName = normalizeTextVariableValue(fullName);
  const safeAlbumName = albumName == null
    ? safeFullName
    : normalizeTextVariableValue(albumName);
  return normalizeTextVariableValue(replaceAllText(
    replaceAllText(sourceText, NAME_VARIABLE, safeAlbumName),
    FULL_NAME_VARIABLE,
    safeFullName,
  ));
}

export function resolveTemplatePreviewTextVariables(value) {
  return resolveStudentNameVariables(
    value,
    FULL_NAME_PREVIEW_PLACEHOLDER,
    ALBUM_NAME_PREVIEW_PLACEHOLDER,
  );
}

export function replaceStudentNameVariables(value = "", student = {}) {
  const fullName = student?.name;
  const effectiveAlbumName = typeof student?.effective_album_name === "string"
    ? student.effective_album_name
    : fullName;
  return resolveStudentNameVariables(value, fullName, effectiveAlbumName);
}

function clampIndex(value, min, max) {
  if (typeof value !== "number" || !Number.isFinite(value)) return max;
  return Math.max(min, Math.min(max, value));
}

export function insertTextToken(value = "", selectionStart, selectionEnd, token = NAME_VARIABLE) {
  const sourceText = String(value ?? "");
  const start = clampIndex(selectionStart, 0, sourceText.length);
  const end = clampIndex(selectionEnd, start, sourceText.length);
  const text = `${sourceText.slice(0, start)}${token}${sourceText.slice(end)}`;
  return { text, caret: start + token.length };
}
