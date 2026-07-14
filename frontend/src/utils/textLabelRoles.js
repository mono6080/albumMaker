import { getVisibleLayoutElements } from "./layoutLayerState.js";

export const TEXT_LABEL_ROLES = {
  FILLABLE: "fillable",
  STATIC: "static",
};

export function getTextLabelRole(label = {}) {
  const rawRole = label.text_role ?? label.textRole;
  if (rawRole === TEXT_LABEL_ROLES.STATIC || label.editable === false) {
    return TEXT_LABEL_ROLES.STATIC;
  }
  return TEXT_LABEL_ROLES.FILLABLE;
}

export function isFillableTextLabel(label = {}) {
  return getTextLabelRole(label) === TEXT_LABEL_ROLES.FILLABLE;
}

export function getFillableTextLabels(layout = {}) {
  return getVisibleLayoutElements(layout, "text").filter(isFillableTextLabel);
}

export function filterFillableLabelTexts(textLabels = [], labelTexts = {}) {
  const fillableIds = new Set(textLabels.filter(isFillableTextLabel).map(label => String(label.id)));
  return Object.fromEntries(
    Object.entries(labelTexts || {}).filter(([labelId]) => fillableIds.has(String(labelId)))
  );
}
