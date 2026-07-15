// 圖片素材文字框分析：負責請求取消、stale guard 與結果套用。

import { useCallback, useEffect, useRef, useState } from "react";
import toast from "react-hot-toast";

import { suggestMaterialTextBox } from "../api/templateApi.js";
import { TEXT_LABEL_ROLES } from "../utils/textLabelRoles.js";
import { ELEMENT_ARRAY_KEY, getNextZIndex } from "../utils/renderLayoutModel.js";
import { getLayoutNodeData } from "../utils/layoutLayerState.js";
import {
  insertNodeInScope,
  linkMaterialText,
} from "../utils/layoutGroupCommands.js";
import { projectNormalizedBoxToSticker } from "../utils/layoutGroupGeometry.js";
import {
  getGroupAncestorPath,
  getMaterialTextLinkForNode,
  getNodeParent,
  getScopeNodes,
} from "../utils/layoutGroupQueries.js";
import { validateLayoutGroups } from "../utils/layoutGroupContractGraph.js";
import { getEditorPageKey } from "./useLayoutHistory.js";

function generateElementId() {
  return Math.floor(Math.random() * 90000) + 10000;
}

function getUniqueElementId(layout) {
  const usedIds = new Set(
    Object.values(ELEMENT_ARRAY_KEY)
      .flatMap(arrayKey => layout?.[arrayKey] || [])
      .map(element => String(element.id)),
  );
  let candidate = generateElementId();
  while (usedIds.has(String(candidate))) candidate = generateElementId();
  return candidate;
}

function createRequestToken() {
  return `material-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function getStickerAnalysisSignature(sticker) {
  if (!sticker) return null;
  return JSON.stringify({
    id: sticker.id,
    path: sticker.path ?? null,
    asset_revision: sticker.asset_revision ?? null,
    x: sticker.x,
    y: sticker.y,
    width: sticker.width,
    height: sticker.height,
    rotation: sticker.rotation ?? 0,
  });
}

export default function useMaterialTextSuggestion({
  templateId,
  currentPage,
  pageLayoutRef,
  activePageSessionIdRef,
  commitPageLayout,
  selectedRefs,
  setSelectedRefs,
  setIsolationPath,
}) {
  const [analyzingTargetKey, setAnalyzingTargetKey] = useState(null);
  const analysisRequestRef = useRef(null);

  const cancelMaterialAnalysis = useCallback(() => {
    analysisRequestRef.current?.controller?.abort();
    analysisRequestRef.current = null;
    setAnalyzingTargetKey(null);
  }, []);

  useEffect(() => () => analysisRequestRef.current?.controller?.abort(), []);

  const handleAnalyzeMaterial = useCallback(async (target) => {
    const layoutSnapshot = pageLayoutRef.current;
    if (!layoutSnapshot || !currentPage) return;
    if (currentPage.id == null) {
      toast.error("請先儲存新增頁面，再分析圖片素材");
      return;
    }
    const currentValidation = validateLayoutGroups(layoutSnapshot);
    if (currentValidation.topologyValid && !currentValidation.linkValid) {
      toast.error("請先清除失效素材連結");
      return;
    }
    const stickerRef = target?.type === "sticker" ? { type: "sticker", id: target.id } : null;
    const sticker = stickerRef ? getLayoutNodeData(layoutSnapshot, stickerRef) : null;
    if (!sticker?.path) {
      toast.error("找不到可分析的圖片素材");
      return;
    }

    const existingLink = getMaterialTextLinkForNode(layoutSnapshot, stickerRef);
    const requestedTextId = target?.textId ?? existingLink?.text_id ?? null;
    const parentGroupId = getNodeParent(layoutSnapshot, stickerRef)?.id ?? null;
    const scopeSignature = JSON.stringify(getScopeNodes(layoutSnapshot, parentGroupId));
    analysisRequestRef.current?.controller?.abort();
    const controller = new AbortController();
    const request = {
      controller,
      pageKey: getEditorPageKey(currentPage),
      pageId: currentPage.id,
      stickerId: sticker.id,
      path: sticker.path,
      sourceRevision: sticker.asset_revision ?? null,
      geometrySignature: getStickerAnalysisSignature(sticker),
      requestToken: createRequestToken(),
      parentGroupId,
      scopeSignature,
      textId: requestedTextId,
      hadExistingLink: !!existingLink,
    };
    analysisRequestRef.current = request;
    setAnalyzingTargetKey(`sticker:${sticker.id}`);

    try {
      const response = await suggestMaterialTextBox(
        templateId,
        currentPage.id,
        {
          stickerId: sticker.id,
          path: sticker.path,
          sourceRevision: sticker.asset_revision ?? null,
          requestToken: request.requestToken,
        },
        { signal: controller.signal },
      );
      const suggestion = response.data;
      if (analysisRequestRef.current !== request) return;
      if (String(activePageSessionIdRef.current) !== String(request.pageKey)) return;

      const currentLayout = pageLayoutRef.current;
      const currentSticker = getLayoutNodeData(
        currentLayout,
        { type: "sticker", id: request.stickerId },
      );
      const currentParentId = currentSticker
        ? getNodeParent(currentLayout, { type: "sticker", id: currentSticker.id })?.id ?? null
        : null;
      const responseMatches = suggestion?.request_token === request.requestToken;
      const sourceMatches = request.sourceRevision == null
        || suggestion?.source_revision === request.sourceRevision;
      if (
        !currentSticker
        || String(currentParentId ?? "") !== String(request.parentGroupId ?? "")
        || JSON.stringify(getScopeNodes(currentLayout, currentParentId)) !== request.scopeSignature
        || !responseMatches
        || !sourceMatches
        || getStickerAnalysisSignature(currentSticker) !== request.geometrySignature
      ) {
        toast.error("圖片或圖層已變更，分析結果未套用，請重新分析");
        return;
      }

      if (suggestion?.status !== "suggested") {
        const unavailableCopy = {
          no_shape: "找不到可可靠放置文字的圖形區域",
          low_confidence: "圖片留白不夠明確，請手動建立文字框",
          image_too_small: "圖片尺寸太小，無法可靠分析",
        };
        toast.error(unavailableCopy[suggestion?.reason] || "目前無法分析這張圖片");
        return;
      }

      let resultTextId = request.textId;
      let resultIsolationPath = [];
      let didApply = false;
      commitPageLayout(baseLayout => {
        if (String(activePageSessionIdRef.current) !== String(request.pageKey)) return baseLayout;
        const latestStickerRef = { type: "sticker", id: request.stickerId };
        const latestSticker = getLayoutNodeData(baseLayout, latestStickerRef);
        const latestParentId = latestSticker
          ? getNodeParent(baseLayout, latestStickerRef)?.id ?? null
          : null;
        if (
          !latestSticker
          || String(latestParentId ?? "") !== String(request.parentGroupId ?? "")
          || JSON.stringify(getScopeNodes(baseLayout, latestParentId)) !== request.scopeSignature
          || getStickerAnalysisSignature(latestSticker) !== request.geometrySignature
        ) return baseLayout;

        const nextGeometry = projectNormalizedBoxToSticker(latestSticker, suggestion.normalized_box);
        const latestLink = getMaterialTextLinkForNode(baseLayout, latestStickerRef);
        if (request.textId != null) {
          if (request.hadExistingLink && String(latestLink?.text_id ?? "") !== String(request.textId)) {
            return baseLayout;
          }
          if (!request.hadExistingLink && latestLink) return baseLayout;
          const linkedTextRef = { type: "text", id: request.textId };
          const linkedText = getLayoutNodeData(baseLayout, linkedTextRef);
          if (!linkedText) return baseLayout;
          if (!request.hadExistingLink) {
            const textParentId = getNodeParent(baseLayout, linkedTextRef)?.id ?? null;
            if (String(textParentId ?? "") !== String(latestParentId ?? "")) return baseLayout;
          }
          didApply = true;
          resultTextId = linkedText.id;
          const textParentId = getNodeParent(baseLayout, linkedTextRef)?.id ?? null;
          resultIsolationPath = textParentId == null
            ? []
            : getGroupAncestorPath(baseLayout, textParentId);
          const withGeometry = {
            ...baseLayout,
            text_labels: (baseLayout.text_labels || []).map(textLabel => (
              String(textLabel.id) === String(linkedText.id)
                ? { ...textLabel, ...nextGeometry }
                : textLabel
            )),
          };
          return linkMaterialText(withGeometry, {
            materialId: latestSticker.id,
            textId: linkedText.id,
          });
        }

        const newTextId = getUniqueElementId(baseLayout);
        const newTextRef = { type: "text", id: newTextId };
        const newTextLabel = {
          id: newTextId,
          ...nextGeometry,
          text: "{name}的文字",
          text_role: TEXT_LABEL_ROLES.FILLABLE,
          font_size: 28,
          font_color: "#3B6B8C",
          font_family: "msjh",
          text_align: "center",
          line_height: 1.4,
          z_index: getNextZIndex(baseLayout),
        };
        let nextLayout = {
          ...baseLayout,
          text_labels: [...(baseLayout.text_labels || []), newTextLabel],
        };
        nextLayout = insertNodeInScope(nextLayout, newTextRef, {
          parentGroupId: latestParentId,
          afterRef: latestStickerRef,
        });
        nextLayout = linkMaterialText(nextLayout, {
          materialId: latestSticker.id,
          textId: newTextId,
        });
        resultTextId = newTextId;
        resultIsolationPath = latestParentId == null
          ? []
          : getGroupAncestorPath(nextLayout, latestParentId);
        didApply = true;
        return nextLayout;
      });

      if (didApply) {
        setIsolationPath(resultIsolationPath);
        setSelectedRefs([{ type: "text", id: resultTextId }]);
        toast.success(request.textId != null ? "已重設文字框" : "已建立文字框");
      } else {
        toast.error("圖片或圖層已變更，分析結果未套用，請重新分析");
      }
    } catch (error) {
      if (error?.code !== "ERR_CANCELED" && error?.name !== "AbortError") {
        const detail = error?.response?.data?.detail;
        const code = typeof detail === "object" ? detail?.code : null;
        toast.error(code === "asset_revision_stale"
          ? "圖片版本已更新，請重新載入後再分析"
          : typeof detail === "string" ? detail : "圖片分析失敗");
      }
    } finally {
      if (analysisRequestRef.current === request) {
        analysisRequestRef.current = null;
        setAnalyzingTargetKey(null);
      }
    }
  }, [
    activePageSessionIdRef,
    commitPageLayout,
    currentPage,
    pageLayoutRef,
    setIsolationPath,
    setSelectedRefs,
    templateId,
  ]);

  const handleLinkSelectedMaterialText = useCallback(() => {
    const stickerRef = selectedRefs.find(ref => ref.type === "sticker");
    const textRef = selectedRefs.find(ref => ref.type === "text");
    if (selectedRefs.length !== 2 || !stickerRef || !textRef) return;
    handleAnalyzeMaterial({ ...stickerRef, textId: textRef.id });
  }, [handleAnalyzeMaterial, selectedRefs]);

  return {
    analyzingTargetKey,
    cancelMaterialAnalysis,
    handleAnalyzeMaterial,
    handleLinkSelectedMaterialText,
  };
}
