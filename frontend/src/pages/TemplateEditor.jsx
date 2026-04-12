import { useEffect, useRef, useState, useCallback } from "react";
import { useParams, useNavigate } from "react-router-dom";
import toast from "react-hot-toast";
import {
  getTemplate, addTemplatePage, updatePageLayout,
  uploadBackground, deleteTemplatePage, uploadSticker, stickerUrl
} from "../api";
import ColorPicker from "../components/ColorPicker";

const CANVAS_W = 530;  // display width; actual A4 stored as 794x1123
const SCALE = CANVAS_W / 794;
const CANVAS_H = Math.round(1123 * SCALE);

const SHAPES = [
  { value: "ellipse",       label: "橢圓",   icon: "⭕" },
  { value: "rect",          label: "方形",   icon: "⬛" },
  { value: "speech_right",  label: "泡→",   icon: "💬" },
  { value: "speech_left",   label: "←泡",   icon: "💬" },
  { value: "speech_bottom", label: "泡↓",   icon: "🗨️" },
  { value: "speech_top",    label: "泡↑",   icon: "🗯️" },
  { value: "cloud",         label: "雲朵",   icon: "☁️" },
  { value: "star",          label: "星形",   icon: "⭐" },
  { value: "heart",         label: "愛心",   icon: "❤️" },
  { value: "diamond",       label: "菱形",   icon: "🔷" },
];
const COLORS = ["#FDED6E", "#B5D5C5", "#FFD1DC", "#C8E6FF", "#E8D5FF", "#FFFFFF"];

const FONTS = [
  { value: "msjh",    label: "微軟正黑體",       css: '"Microsoft JhengHei", sans-serif' },
  { value: "msjhbd",  label: "微軟正黑體 Bold",   css: '"Microsoft JhengHei", sans-serif', bold: true },
  { value: "kaiu",    label: "標楷體",            css: '"DFKai-SB", "標楷體", serif' },
  { value: "mingliu", label: "細明體",            css: '"MingLiU", serif' },
  { value: "simsun",  label: "新細明體",          css: '"SimSun", serif' },
  { value: "msyh",    label: "微軟雅黑",          css: '"Microsoft YaHei", sans-serif' },
];

function generateId() {
  return Math.floor(Math.random() * 90000) + 10000;
}

function toDisplay(v) { return v * SCALE; }
function toReal(v) { return Math.round(v / SCALE); }

function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

// SVG bubble that exactly mirrors PIL's _draw_speech_bubble geometry.
// w/h are in display pixels; borderRadius/borderWidth also in display pixels.
function BubbleSVG({ w, h, fill, borderColor, borderWidth, shape, borderRadius, isSelected }) {
  const hasStroke = !!(borderColor && borderWidth > 0);
  const stroke = hasStroke ? borderColor : "none";
  const sw = hasStroke ? borderWidth : 0;
  const defaultR = Math.round(Math.min(w, h) / 5);
  const r = Math.max(0, borderRadius ?? defaultR);

  const tail_h = Math.round(h / 4);
  const tail_w = Math.round(w / 5);
  const midX = w / 2;
  const midY = h / 2;

  const selStroke = isSelected ? "#4F46E5" : "none";
  const selSw = isSelected ? 2 : 0;

  function shapeEls(f, s, sW) {
    switch (shape) {
      case "rect":
        return <rect x={0} y={0} width={w} height={h} rx={r} fill={f} stroke={s} strokeWidth={sW} />;

      case "speech_right": {
        const tip_y = h * 3 / 4;
        const pts = `${w - 2},${tip_y - tail_h / 2} ${w - 2},${tip_y + tail_h / 2} ${w + tail_w},${tip_y}`;
        return <>
          <rect x={0} y={0} width={w} height={h} rx={r} fill={f} stroke={s} strokeWidth={sW} />
          <polygon points={pts} fill={f} stroke={hasStroke ? s : "none"} strokeWidth={sW} />
        </>;
      }

      case "speech_left": {
        const tip_y = h * 3 / 4;
        const pts = `${2},${tip_y - tail_h / 2} ${2},${tip_y + tail_h / 2} ${-tail_w},${tip_y}`;
        return <>
          <rect x={0} y={0} width={w} height={h} rx={r} fill={f} stroke={s} strokeWidth={sW} />
          <polygon points={pts} fill={f} stroke={hasStroke ? s : "none"} strokeWidth={sW} />
        </>;
      }

      case "speech_bottom": {
        const pts = `${midX - tail_w / 2},${h - 2} ${midX + tail_w / 2},${h - 2} ${midX},${h + tail_h}`;
        return <>
          <rect x={0} y={0} width={w} height={h} rx={r} fill={f} stroke={s} strokeWidth={sW} />
          <polygon points={pts} fill={f} />
        </>;
      }

      case "speech_top": {
        const pts = `${midX - tail_w / 2},${2} ${midX + tail_w / 2},${2} ${midX},${-tail_h}`;
        return <>
          <rect x={0} y={0} width={w} height={h} rx={r} fill={f} stroke={s} strokeWidth={sW} />
          <polygon points={pts} fill={f} />
        </>;
      }

      case "cloud": {
        const body_top = h * 2 / 5;
        const cloud_r = Math.min(r, h / 4);
        const num_bumps = Math.max(3, Math.floor(w / 60));
        const bump_r = Math.floor(w / (num_bumps * 2));
        return <>
          <rect x={0} y={body_top} width={w} height={h - body_top} rx={cloud_r} fill={f} />
          {Array.from({ length: num_bumps }, (_, i) => {
            const bx = bump_r + i * (w - bump_r * 2) / Math.max(num_bumps - 1, 1);
            return <ellipse key={i} cx={bx} cy={body_top} rx={bump_r} ry={bump_r} fill={f} />;
          })}
          {hasStroke && <rect x={0} y={body_top} width={w} height={h - body_top} rx={cloud_r}
            fill="none" stroke={s} strokeWidth={sW} />}
        </>;
      }

      case "star": {
        const outer = Math.min(w, h) / 2;
        const inner = outer * 2 / 5;
        const pts = Array.from({ length: 10 }, (_, i) => {
          const angle = Math.PI / 2 + i * Math.PI / 5;
          const ri = i % 2 === 0 ? outer : inner;
          return `${midX + ri * Math.cos(angle)},${midY - ri * Math.sin(angle)}`;
        }).join(" ");
        return <polygon points={pts} fill={f} stroke={s} strokeWidth={sW} />;
      }

      case "heart": {
        const hw = Math.floor(w / 2);
        const hh = Math.round(h * 0.55);
        return <>
          <ellipse cx={(hw + 4) / 2} cy={hh} rx={(hw + 4) / 2} ry={hh} fill={f} />
          <ellipse cx={(hw - 4 + w) / 2} cy={hh} rx={(w - (hw - 4)) / 2} ry={hh} fill={f} />
          <polygon points={`0,${hh} ${w},${hh} ${midX},${h}`} fill={f} />
        </>;
      }

      case "diamond": {
        const pts = `${midX},0 ${w},${midY} ${midX},${h} 0,${midY}`;
        return <polygon points={pts} fill={f} stroke={s} strokeWidth={sW} />;
      }

      default: // ellipse
        return <ellipse cx={midX} cy={midY} rx={w / 2} ry={h / 2} fill={f} stroke={s} strokeWidth={sW} />;
    }
  }

  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`}
      style={{ position: "absolute", left: 0, top: 0, overflow: "visible", pointerEvents: "none" }}>
      {shapeEls(fill, stroke, sw)}
      {isSelected && shapeEls("none", selStroke, selSw)}
    </svg>
  );
}

export default function TemplateEditor() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [template, setTemplate] = useState(null);
  const [pageIdx, setPageIdx] = useState(0);
  const [layout, setLayout] = useState(null);
  const [selected, setSelected] = useState(null); // { type: 'photo'|'bubble', id }
  const [bgUrl, setBgUrl] = useState(null);
  const [tool, setTool] = useState("select"); // select | addPhoto | addBubble
  const [dragging, setDragging] = useState(null);
  const [resizing, setResizing] = useState(null);
  const [rotating, setRotating] = useState(null); // { type, id, centerX, centerY, startAngle, origRotation }
  const canvasRef = useRef(null);
  const [saving, setSaving] = useState(false);
  const stickerInputRef = useRef(null);

  const loadTemplate = useCallback(() => {
    getTemplate(id).then(r => {
      setTemplate(r.data);
      const pages = r.data.pages;
      if (pages.length > 0) {
        const p = pages[Math.min(pageIdx, pages.length - 1)];
        setLayout(p.layout);
        if (p.background_filename) {
          setBgUrl(`/api/templates/${id}/pages/${p.id}/background?t=${Date.now()}`);
        } else {
          setBgUrl(null);
        }
      }
    });
  }, [id, pageIdx]);

  useEffect(() => { loadTemplate(); }, [loadTemplate]);

  // Switch page
  useEffect(() => {
    if (!template) return;
    const pages = template.pages;
    if (pages.length === 0) return;
    const p = pages[Math.min(pageIdx, pages.length - 1)];
    setLayout(p.layout);
    setSelected(null);
    if (p.background_filename) {
      setBgUrl(`/api/templates/${id}/pages/${p.id}/background?t=${Date.now()}`);
    } else {
      setBgUrl(null);
    }
  }, [pageIdx, template, id]);

  const currentPage = template?.pages[Math.min(pageIdx, (template?.pages.length ?? 1) - 1)];

  const save = async () => {
    if (!layout || !currentPage) return;
    setSaving(true);
    try {
      await updatePageLayout(id, currentPage.id, layout);
      toast.success("已儲存");
    } catch {
      toast.error("儲存失敗");
    }
    setSaving(false);
  };

  const handleAddPage = async () => {
    await addTemplatePage(id);
    await loadTemplate();
    setPageIdx(template.pages.length); // go to new page
    toast.success("已新增頁面");
  };

  const handleDeletePage = async () => {
    if (!currentPage) return;
    if (!confirm("確定刪除此頁？")) return;
    await deleteTemplatePage(id, currentPage.id);
    setPageIdx(Math.max(0, pageIdx - 1));
    await loadTemplate();
    toast.success("已刪除頁面");
  };

  const handleBgUpload = async (e) => {
    const file = e.target.files[0];
    if (!file || !currentPage) return;
    await uploadBackground(id, currentPage.id, file);
    setBgUrl(`/api/templates/${id}/pages/${currentPage.id}/background?t=${Date.now()}`);
    toast.success("背景已上傳");
    e.target.value = "";
  };

  // ── Canvas interaction ────────────────────────────────────────────────────

  const getCanvasPos = (e) => {
    const rect = canvasRef.current.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const hitTest = (pos) => {
    if (!layout) return null;
    // Check stickers first (topmost layer)
    for (const s of [...(layout.stickers || [])].reverse()) {
      const dx = toDisplay(s.x), dy = toDisplay(s.y);
      const dw = toDisplay(s.width), dh = toDisplay(s.height);
      if (pos.x >= dx && pos.x <= dx + dw && pos.y >= dy && pos.y <= dy + dh)
        return { type: "sticker", id: s.id };
    }
    for (const b of [...layout.text_bubbles].reverse()) {
      const dx = toDisplay(b.x), dy = toDisplay(b.y);
      const dw = toDisplay(b.width), dh = toDisplay(b.height);
      if (pos.x >= dx && pos.x <= dx + dw && pos.y >= dy && pos.y <= dy + dh)
        return { type: "bubble", id: b.id };
    }
    for (const s of [...layout.photo_slots].reverse()) {
      const dx = toDisplay(s.x), dy = toDisplay(s.y);
      const dw = toDisplay(s.width), dh = toDisplay(s.height);
      if (pos.x >= dx && pos.x <= dx + dw && pos.y >= dy && pos.y <= dy + dh)
        return { type: "photo", id: s.id };
    }
    return null;
  };

  const onMouseDown = (e) => {
    if (!layout) return;
    const pos = getCanvasPos(e);

    if (tool === "addPhoto") {
      const newSlot = {
        id: generateId(),
        x: toReal(pos.x), y: toReal(pos.y),
        width: 300, height: 220, rotation: 0,
        border: true, border_width: 8
      };
      setLayout(l => ({ ...l, photo_slots: [...l.photo_slots, newSlot] }));
      setTool("select");
      setSelected({ type: "photo", id: newSlot.id });
      return;
    }

    if (tool === "addBubble") {
      const newBubble = {
        id: generateId(),
        x: toReal(pos.x), y: toReal(pos.y),
        width: 180, height: 110,
        shape: "ellipse", fill: "#FDED6E",
        border_color: null, border_width: 0,
        text: "{name}的描述文字", font_size: 20,
        font_color: "#3B6B8C", line_height: 1.4,
        font_family: "msjh", tail_side: "right"
      };
      setLayout(l => ({ ...l, text_bubbles: [...l.text_bubbles, newBubble] }));
      setTool("select");
      setSelected({ type: "bubble", id: newBubble.id });
      return;
    }

    // select tool
    const hit = hitTest(pos);
    if (hit) {
      setSelected(hit);
      // Check resize handle (bottom-right corner)
      const item = getItem(hit);
      if (item) {
        const bx = toDisplay(item.x) + toDisplay(item.width) - 10;
        const by = toDisplay(item.y) + toDisplay(item.height) - 10;
        if (pos.x >= bx && pos.y >= by) {
          setResizing({ ...hit, startX: pos.x, startY: pos.y, origW: item.width, origH: item.height });
          return;
        }
      }
      setDragging({ ...hit, startX: pos.x, startY: pos.y, origX: getItem(hit)?.x, origY: getItem(hit)?.y });
    } else {
      setSelected(null);
    }
  };

  const getItem = ({ type, id }) => {
    if (!layout) return null;
    if (type === "photo") return layout.photo_slots.find(s => s.id === id);
    if (type === "bubble") return layout.text_bubbles.find(b => b.id === id);
    if (type === "sticker") return (layout.stickers || []).find(s => s.id === id);
    return null;
  };

  const updateItem = (type, id, updates) => {
    setLayout(l => {
      if (type === "photo")
        return { ...l, photo_slots: l.photo_slots.map(s => s.id === id ? { ...s, ...updates } : s) };
      if (type === "bubble")
        return { ...l, text_bubbles: l.text_bubbles.map(b => b.id === id ? { ...b, ...updates } : b) };
      if (type === "sticker")
        return { ...l, stickers: (l.stickers || []).map(s => s.id === id ? { ...s, ...updates } : s) };
      return l;
    });
  };

  const onMouseMove = (e) => {
    if (dragging) {
      const pos = getCanvasPos(e);
      const dx = toReal(pos.x - dragging.startX);
      const dy = toReal(pos.y - dragging.startY);
      updateItem(dragging.type, dragging.id, {
        x: clamp(dragging.origX + dx, 0, 794 - (getItem(dragging)?.width ?? 100)),
        y: clamp(dragging.origY + dy, 0, 1123 - (getItem(dragging)?.height ?? 60))
      });
    }
    if (resizing) {
      const pos = getCanvasPos(e);
      const dx = toReal(pos.x - resizing.startX);
      const dy = toReal(pos.y - resizing.startY);
      if (e.shiftKey) {
        // 等比縮放：取 dx/dy 中較大的那個方向，按原始比例計算另一邊
        const ratio = resizing.origW / resizing.origH;
        const d = Math.abs(dx) >= Math.abs(dy) ? dx : dy * ratio;
        const newW = Math.max(60, resizing.origW + d);
        const newH = Math.max(40, newW / ratio);
        updateItem(resizing.type, resizing.id, { width: newW, height: newH });
      } else {
        updateItem(resizing.type, resizing.id, {
          width: Math.max(60, resizing.origW + dx),
          height: Math.max(40, resizing.origH + dy)
        });
      }
    }
    if (rotating) {
      const pos = getCanvasPos(e);
      const angle = Math.atan2(pos.y - rotating.centerY, pos.x - rotating.centerX) * (180 / Math.PI);
      const delta = angle - rotating.startAngle;
      const newRot = rotating.origRotation + delta;
      // Snap to 0.5° increments; hold Shift to snap to 15°
      const snap = e.shiftKey ? 15 : 0.5;
      updateItem(rotating.type, rotating.id, { rotation: Math.round(newRot / snap) * snap });
    }
  };

  const onMouseUp = () => { setDragging(null); setResizing(null); setRotating(null); };

  const deleteSelected = () => {
    if (!selected) return;
    if (selected.type === "photo")
      setLayout(l => ({ ...l, photo_slots: l.photo_slots.filter(s => s.id !== selected.id) }));
    else if (selected.type === "bubble")
      setLayout(l => ({ ...l, text_bubbles: l.text_bubbles.filter(b => b.id !== selected.id) }));
    else if (selected.type === "sticker")
      setLayout(l => ({ ...l, stickers: (l.stickers || []).filter(s => s.id !== selected.id) }));
    setSelected(null);
  };

  const handleStickerUpload = async (file) => {
    if (!file) return;
    try {
      const res = await uploadSticker(id, file);
      const { path, filename } = res.data;
      const newSticker = {
        id: generateId(), path, filename,
        x: 50, y: 50, width: 150, height: 150, rotation: 0,
      };
      setLayout(l => ({ ...l, stickers: [...(l.stickers || []), newSticker] }));
      setSelected({ type: "sticker", id: newSticker.id });
      toast.success("貼圖已上傳");
    } catch { toast.error("上傳失敗"); }
  };

  // ── Render ────────────────────────────────────────────────────────────────

  if (!template) return <div className="text-gray-400">載入中...</div>;
  if (template.pages.length === 0) {
    return (
      <div>
        <h1 className="text-2xl font-bold mb-4">編輯模板：{template.name}</h1>
        <button onClick={handleAddPage} className="bg-indigo-600 text-white px-4 py-2 rounded">新增第一頁</button>
      </div>
    );
  }

  const selectedItem = selected ? getItem(selected) : null;

  return (
    <div>
      <div className="flex items-center gap-4 mb-4">
        <button onClick={() => navigate("/templates")} className="text-gray-500 hover:text-gray-700">← 返回</button>
        <h1 className="text-xl font-bold">{template.name}</h1>
        <span className="text-gray-400 text-sm">模板編輯器</span>
      </div>

      <div className="flex gap-6">
        {/* Left: Canvas */}
        <div className="flex-shrink-0">
          {/* Page tabs */}
          <div className="flex gap-1 mb-2">
            {template.pages.map((p, i) => (
              <button
                key={p.id}
                onClick={() => setPageIdx(i)}
                className={`px-3 py-1 rounded text-sm border ${pageIdx === i ? "bg-indigo-600 text-white" : "bg-white text-gray-600 hover:bg-gray-50"}`}
              >
                第 {i + 1} 頁
              </button>
            ))}
            <button onClick={handleAddPage} className="px-3 py-1 rounded text-sm border bg-white hover:bg-gray-50">+ 新增頁</button>
          </div>

          {/* Toolbar */}
          <div className="flex gap-2 mb-2">
            {[
              { key: "select", label: "選取" },
              { key: "addPhoto", label: "＋照片格" },
              { key: "addBubble", label: "＋氣泡框" },
            ].map(t => (
              <button
                key={t.key}
                onClick={() => setTool(t.key)}
                className={`px-3 py-1 rounded text-sm border ${tool === t.key ? "bg-indigo-600 text-white" : "bg-white hover:bg-gray-50"}`}
              >
                {t.label}
              </button>
            ))}
            <label className="px-3 py-1 rounded text-sm border bg-white hover:bg-gray-50 cursor-pointer">
              上傳背景
              <input type="file" accept="image/*" className="hidden" onChange={handleBgUpload} />
            </label>
            <label className="px-3 py-1 rounded text-sm border bg-white hover:bg-gray-50 cursor-pointer">
              ＋貼圖素材
              <input ref={stickerInputRef} type="file" accept="image/*" className="hidden"
                onChange={e => { if (e.target.files?.[0]) { handleStickerUpload(e.target.files[0]); e.target.value = ""; } }} />
            </label>
            {selected && (
              <button onClick={deleteSelected} className="px-3 py-1 rounded text-sm border border-red-300 text-red-500 hover:bg-red-50">
                刪除選取
              </button>
            )}
            <button
              onClick={handleDeletePage}
              className="px-3 py-1 rounded text-sm border border-red-200 text-red-400 hover:bg-red-50"
            >
              刪除此頁
            </button>
            <button
              onClick={save}
              disabled={saving}
              className="ml-auto px-4 py-1 rounded text-sm bg-green-600 text-white hover:bg-green-700 disabled:opacity-50"
            >
              {saving ? "儲存中..." : "儲存"}
            </button>
          </div>

          {/* Canvas */}
          <div
            ref={canvasRef}
            style={{ width: CANVAS_W, height: CANVAS_H, position: "relative", cursor: rotating ? "grabbing" : tool === "select" ? "default" : "crosshair" }}
            className="border border-gray-300 rounded overflow-hidden bg-white select-none"
            onMouseDown={onMouseDown}
            onMouseMove={onMouseMove}
            onMouseUp={onMouseUp}
            onMouseLeave={onMouseUp}
          >
            {/* Background */}
            {bgUrl && (
              <img
                src={bgUrl}
                style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", pointerEvents: "none" }}
                alt=""
                draggable={false}
              />
            )}
            {!bgUrl && (
              <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center" }}
                className="text-gray-300 text-sm pointer-events-none">
                請上傳背景圖
              </div>
            )}

            {/* Photo slots */}
            {layout?.photo_slots?.map(slot => {
              const isSel = selected?.type === "photo" && selected?.id === slot.id;
              const hasBorder = slot.border !== false;
              const bw = toDisplay(slot.border_width ?? 8);
              const slotRadius = toDisplay(slot.border_radius ?? 0);
              const shEnabled = slot.shadow_enabled ?? hasBorder;
              const shX = toDisplay(slot.shadow_offset_x ?? 5);
              const shY = toDisplay(slot.shadow_offset_y ?? 8);
              const shBlur = toDisplay(slot.shadow_blur ?? 14);
              const shOpacity = ((slot.shadow_opacity ?? 120) / 255).toFixed(2);
              const boxShadow = shEnabled
                ? `${shX}px ${shY}px ${shBlur}px rgba(0,0,0,${shOpacity})`
                : "none";
              return (
                <div
                  key={slot.id}
                  style={{
                    position: "absolute",
                    left: toDisplay(slot.x),
                    top: toDisplay(slot.y),
                    width: toDisplay(slot.width),
                    height: toDisplay(slot.height),
                    transform: `rotate(${slot.rotation}deg)`,
                    transformOrigin: "center",
                    background: hasBorder ? "#ffffff" : "#EEEEEE",
                    boxShadow,
                    borderRadius: slotRadius,
                    outline: isSel ? "2px solid #4F46E5" : hasBorder ? "1px solid #e2e8f0" : "1px solid #CCCCCC",
                    outlineOffset: isSel ? 2 : 0,
                    pointerEvents: "none",
                    boxSizing: "border-box",
                    overflow: "hidden",
                  }}
                >
                  {/* Polaroid inner photo area */}
                  {hasBorder ? (
                    <div style={{
                      position: "absolute",
                      left: bw, top: bw, right: bw, bottom: bw * 2,
                      background: "#EEEEEE",
                      borderRadius: Math.max(0, slotRadius - bw),
                      display: "flex", alignItems: "center", justifyContent: "center",
                    }}>
                      <span style={{ fontSize: 10, color: "#AAAAAA", userSelect: "none" }}>P{pageIdx + 1}·{slot.id}</span>
                    </div>
                  ) : (
                    <div style={{
                      position: "absolute", inset: 0,
                      display: "flex", alignItems: "center", justifyContent: "center",
                    }}>
                      <span style={{ fontSize: 10, color: "#AAAAAA", userSelect: "none" }}>P{pageIdx + 1}·{slot.id}</span>
                    </div>
                  )}
                  {isSel && (
                    <>
                      {/* Resize handle — bottom-right */}
                      <div style={{
                        position: "absolute", bottom: -4, right: -4,
                        width: 12, height: 12, background: "#4F46E5",
                        borderRadius: 2, cursor: "se-resize", pointerEvents: "auto"
                      }} />
                      {/* Rotation handle — top-center */}
                      <div
                        title="拖曳旋轉（Shift=15°對齊）"
                        style={{
                          position: "absolute",
                          top: -28,
                          left: "50%",
                          transform: "translateX(-50%)",
                          pointerEvents: "auto",
                          cursor: "grab",
                          display: "flex",
                          flexDirection: "column",
                          alignItems: "center",
                          gap: 2,
                        }}
                        onMouseDown={e => {
                          e.stopPropagation();
                          const pos = getCanvasPos(e);
                          const cx = toDisplay(slot.x) + toDisplay(slot.width) / 2;
                          const cy = toDisplay(slot.y) + toDisplay(slot.height) / 2;
                          const startAngle = Math.atan2(pos.y - cy, pos.x - cx) * (180 / Math.PI);
                          setRotating({ type: "photo", id: slot.id, centerX: cx, centerY: cy, startAngle, origRotation: slot.rotation ?? 0 });
                        }}
                      >
                        {/* Stem */}
                        <div style={{ width: 1, height: 10, background: "#4F46E5" }} />
                        {/* Circle */}
                        <div style={{
                          width: 14, height: 14,
                          borderRadius: "50%",
                          background: "#fff",
                          border: "2px solid #4F46E5",
                          boxShadow: "0 1px 4px rgba(0,0,0,0.18)",
                        }} />
                      </div>
                    </>
                  )}
                </div>
              );
            })}

            {/* Text bubbles */}
            {layout?.text_bubbles?.map(bubble => {
              const isSel = selected?.type === "bubble" && selected?.id === bubble.id;
              const dW = toDisplay(bubble.width);
              const dH = toDisplay(bubble.height);
              const dBR = bubble.border_radius != null
                ? toDisplay(bubble.border_radius)
                : Math.round(Math.min(dW, dH) / 5);
              const dBW = bubble.border_width > 0 ? toDisplay(bubble.border_width) : 0;
              return (
                <div
                  key={bubble.id}
                  style={{
                    position: "absolute",
                    left: toDisplay(bubble.x),
                    top: toDisplay(bubble.y),
                    width: dW,
                    height: dH,
                    transform: `rotate(${bubble.rotation ?? 0}deg)`,
                    transformOrigin: "center",
                    pointerEvents: "none",
                    overflow: "visible",
                  }}
                >
                  <BubbleSVG
                    w={dW} h={dH}
                    fill={bubble.fill}
                    borderColor={bubble.border_color}
                    borderWidth={dBW}
                    shape={bubble.shape ?? "ellipse"}
                    borderRadius={dBR}
                    isSelected={isSel}
                  />
                  <span style={{
                    position: "absolute", inset: 0,
                    display: "flex", alignItems: "center", justifyContent: "center",
                    fontSize: Math.max(8, toDisplay(bubble.font_size ?? 20)),
                    color: bubble.font_color,
                    textAlign: "center", padding: 4, lineHeight: 1.3,
                    overflow: "hidden", pointerEvents: "none",
                    fontFamily: FONTS.find(f => f.value === bubble.font_family)?.css ?? "sans-serif",
                    fontWeight: FONTS.find(f => f.value === bubble.font_family)?.bold ? "bold" : "normal",
                  }}>
                    {bubble.text?.substring(0, 30)}
                  </span>
                  {isSel && (
                    <>
                      <div style={{
                        position: "absolute", bottom: -4, right: -4,
                        width: 12, height: 12, background: "#4F46E5",
                        borderRadius: 2, cursor: "se-resize", pointerEvents: "auto"
                      }} />
                      {/* Rotation handle */}
                      <div
                        title="拖曳旋轉（Shift=15°對齊）"
                        style={{
                          position: "absolute", top: -28, left: "50%",
                          transform: "translateX(-50%)",
                          pointerEvents: "auto", cursor: "grab",
                          display: "flex", flexDirection: "column", alignItems: "center", gap: 2,
                        }}
                        onMouseDown={e => {
                          e.stopPropagation();
                          const pos = getCanvasPos(e);
                          const cx = toDisplay(bubble.x) + toDisplay(bubble.width) / 2;
                          const cy = toDisplay(bubble.y) + toDisplay(bubble.height) / 2;
                          const startAngle = Math.atan2(pos.y - cy, pos.x - cx) * (180 / Math.PI);
                          setRotating({ type: "bubble", id: bubble.id, centerX: cx, centerY: cy, startAngle, origRotation: bubble.rotation ?? 0 });
                        }}
                      >
                        <div style={{ width: 1, height: 10, background: "#4F46E5" }} />
                        <div style={{
                          width: 14, height: 14, borderRadius: "50%",
                          background: "#fff", border: "2px solid #4F46E5",
                          boxShadow: "0 1px 4px rgba(0,0,0,0.18)",
                        }} />
                      </div>
                    </>
                  )}
                </div>
              );
            })}

            {/* Stickers */}
            {(layout?.stickers || []).map(sticker => {
              const isSel = selected?.type === "sticker" && selected?.id === sticker.id;
              return (
                <div
                  key={sticker.id}
                  style={{
                    position: "absolute",
                    left: toDisplay(sticker.x), top: toDisplay(sticker.y),
                    width: toDisplay(sticker.width), height: toDisplay(sticker.height),
                    transform: `rotate(${sticker.rotation ?? 0}deg)`,
                    transformOrigin: "center",
                    outline: isSel ? "2px solid #4F46E5" : "none",
                    outlineOffset: 2,
                    pointerEvents: "none",
                    overflow: "visible",
                  }}
                >
                  <img
                    src={stickerUrl(id, sticker.filename)}
                    alt=""
                    draggable={false}
                    style={{ width: "100%", height: "100%", objectFit: "contain", display: "block" }}
                  />
                  {isSel && (
                    <>
                      <div style={{
                        position: "absolute", bottom: -4, right: -4,
                        width: 12, height: 12, background: "#4F46E5",
                        borderRadius: 2, cursor: "se-resize", pointerEvents: "auto"
                      }} />
                      <div
                        title="拖曳旋轉（Shift=15°對齊）"
                        style={{
                          position: "absolute", top: -28, left: "50%",
                          transform: "translateX(-50%)",
                          pointerEvents: "auto", cursor: "grab",
                          display: "flex", flexDirection: "column", alignItems: "center", gap: 2,
                        }}
                        onMouseDown={e => {
                          e.stopPropagation();
                          const pos = getCanvasPos(e);
                          const cx = toDisplay(sticker.x) + toDisplay(sticker.width) / 2;
                          const cy = toDisplay(sticker.y) + toDisplay(sticker.height) / 2;
                          const startAngle = Math.atan2(pos.y - cy, pos.x - cx) * (180 / Math.PI);
                          setRotating({ type: "sticker", id: sticker.id, centerX: cx, centerY: cy, startAngle, origRotation: sticker.rotation ?? 0 });
                        }}
                      >
                        <div style={{ width: 1, height: 10, background: "#4F46E5" }} />
                        <div style={{
                          width: 14, height: 14, borderRadius: "50%",
                          background: "#fff", border: "2px solid #4F46E5",
                          boxShadow: "0 1px 4px rgba(0,0,0,0.18)",
                        }} />
                      </div>
                    </>
                  )}
                </div>
              );
            })}
          </div>

          <p className="text-xs text-gray-400 mt-1">提示：點選工具後在畫布上點擊放置；拖曳移動；右下角拖曳調整大小</p>
        </div>

        {/* Right: Properties panel */}
        <div className="flex-1 min-w-0">
          {selected && selectedItem ? (
            <PropertyPanel
              selected={selected}
              item={selectedItem}
              onChange={(updates) => updateItem(selected.type, selected.id, updates)}
            />
          ) : (
            <div className="text-gray-400 text-sm mt-8">點選畫布上的元素以編輯屬性</div>
          )}
        </div>
      </div>
    </div>
  );
}

function PropertyPanel({ selected, item, onChange }) {
  const isPhoto = selected.type === "photo";
  const isBubble = selected.type === "bubble";
  const isSticker = selected.type === "sticker";
  const currentFont = FONTS.find(f => f.value === item.font_family) ?? FONTS[0];

  return (
    <div className="bg-white border rounded-lg p-4 space-y-4">
      <h3 className="font-semibold">{isPhoto ? "📷 照片格屬性" : isSticker ? "🖼️ 貼圖素材屬性" : "💬 氣泡框屬性"}</h3>

      <div className="grid grid-cols-2 gap-3">
        {["x", "y", "width", "height"].map(k => (
          <label key={k} className="flex flex-col gap-1">
            <span className="text-xs text-gray-500">{k === "x" ? "X 位置" : k === "y" ? "Y 位置" : k === "width" ? "寬度" : "高度"}</span>
            <input
              type="number"
              value={item[k] ?? 0}
              onChange={e => onChange({ [k]: Number(e.target.value) })}
              className="border rounded px-2 py-1 text-sm"
            />
          </label>
        ))}
      </div>

      {(isPhoto || isSticker || isBubble) && (
        <label className="flex flex-col gap-1">
          <span className="text-xs text-gray-500">旋轉角度（度）</span>
          <input
            type="number" step="0.5"
            value={item.rotation ?? 0}
            onChange={e => onChange({ rotation: Number(e.target.value) })}
            className="border rounded px-2 py-1 text-sm w-24"
          />
        </label>
      )}

      {isPhoto && (
        <>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={item.border ?? true}
              onChange={e => onChange({ border: e.target.checked })}
            />
            <span className="text-sm">白色外框（拍立得風格）</span>
          </label>
          {item.border && (
            <label className="flex flex-col gap-1">
              <span className="text-xs text-gray-500">外框寬度</span>
              <input
                type="number"
                value={item.border_width ?? 8}
                onChange={e => onChange({ border_width: Number(e.target.value) })}
                className="border rounded px-2 py-1 text-sm w-24"
              />
            </label>
          )}
          <label className="flex flex-col gap-1">
            <span className="text-xs text-gray-500">圓角半徑（px）</span>
            <div className="flex items-center gap-2">
              <input
                type="range" min="0" max={Math.round(Math.min(item.width, item.height) / 2)}
                value={item.border_radius ?? 0}
                onChange={e => onChange({ border_radius: Number(e.target.value) })}
                className="flex-1"
              />
              <input
                type="number" min="0" max={Math.round(Math.min(item.width, item.height) / 2)}
                value={item.border_radius ?? 0}
                onChange={e => onChange({ border_radius: Number(e.target.value) })}
                className="border rounded px-1 py-1 text-sm w-14 text-center"
              />
            </div>
          </label>

          {/* Shadow settings */}
          <div className="space-y-2 pt-1 border-t border-gray-100">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={item.shadow_enabled ?? (item.border !== false)}
                onChange={e => onChange({ shadow_enabled: e.target.checked })}
              />
              <span className="text-sm font-medium text-gray-700">陰影</span>
            </label>
            {(item.shadow_enabled ?? (item.border !== false)) && (
              <div className="space-y-2 pl-1">
                {[
                  { key: "shadow_offset_x", label: "偏移 X", def: 5, min: -30, max: 30 },
                  { key: "shadow_offset_y", label: "偏移 Y", def: 8, min: -30, max: 30 },
                  { key: "shadow_blur",     label: "模糊",   def: 14, min: 0, max: 40 },
                ].map(({ key, label, def, min, max }) => (
                  <label key={key} className="flex flex-col gap-0.5">
                    <span className="text-xs text-gray-500">{label}</span>
                    <div className="flex items-center gap-2">
                      <input
                        type="range" min={min} max={max}
                        value={item[key] ?? def}
                        onChange={e => onChange({ [key]: Number(e.target.value) })}
                        className="flex-1"
                      />
                      <input
                        type="number" min={min} max={max}
                        value={item[key] ?? def}
                        onChange={e => onChange({ [key]: Number(e.target.value) })}
                        className="border rounded px-1 py-1 text-sm w-14 text-center"
                      />
                    </div>
                  </label>
                ))}
                <label className="flex flex-col gap-0.5">
                  <span className="text-xs text-gray-500">不透明度（%）</span>
                  <div className="flex items-center gap-2">
                    <input
                      type="range" min="0" max="100"
                      value={Math.round(((item.shadow_opacity ?? 120) / 255) * 100)}
                      onChange={e => onChange({ shadow_opacity: Math.round(Number(e.target.value) / 100 * 255) })}
                      className="flex-1"
                    />
                    <input
                      type="number" min="0" max="100"
                      value={Math.round(((item.shadow_opacity ?? 120) / 255) * 100)}
                      onChange={e => onChange({ shadow_opacity: Math.round(Number(e.target.value) / 100 * 255) })}
                      className="border rounded px-1 py-1 text-sm w-14 text-center"
                    />
                  </div>
                </label>
              </div>
            )}
          </div>
        </>
      )}

      {isBubble && (
        <>
          <div className="flex flex-col gap-1">
            <span className="text-xs text-gray-500">形狀</span>
            <div className="grid grid-cols-5 gap-1">
              {SHAPES.map(s => (
                <button
                  key={s.value}
                  onClick={() => onChange({ shape: s.value })}
                  title={s.label}
                  className={`flex flex-col items-center gap-0.5 py-1.5 rounded border text-xs transition-colors ${
                    item.shape === s.value
                      ? "border-indigo-500 bg-indigo-50 text-indigo-700"
                      : "border-gray-200 hover:border-gray-300 text-gray-600"
                  }`}
                >
                  <span className="text-base leading-none">{s.icon}</span>
                  <span className="text-[10px]">{s.label}</span>
                </button>
              ))}
            </div>
          </div>

          {item.shape !== "ellipse" && (
            <label className="flex flex-col gap-1">
              <span className="text-xs text-gray-500">圓角半徑（px）</span>
              <div className="flex items-center gap-2">
                <input
                  type="range" min="0" max={Math.round(Math.min(item.width, item.height) / 2)}
                  value={item.border_radius ?? Math.round(Math.min(item.width, item.height) / 5)}
                  onChange={e => onChange({ border_radius: Number(e.target.value) })}
                  className="flex-1"
                />
                <input
                  type="number" min="0" max={Math.round(Math.min(item.width, item.height) / 2)}
                  value={item.border_radius ?? Math.round(Math.min(item.width, item.height) / 5)}
                  onChange={e => onChange({ border_radius: Number(e.target.value) })}
                  className="border rounded px-1 py-1 text-sm w-14 text-center"
                />
              </div>
            </label>
          )}

          <ColorPicker
            label="背景顏色"
            value={item.fill}
            onChange={v => onChange({ fill: v })}
          />

          <label className="flex flex-col gap-1">
            <span className="text-xs text-gray-500">預設文字（可用 {"{name}"} 代入姓名）</span>
            <textarea
              rows={3}
              value={item.text ?? ""}
              onChange={e => onChange({ text: e.target.value })}
              className="border rounded px-2 py-1 text-sm"
            />
          </label>

          {/* Font family */}
          <label className="flex flex-col gap-1">
            <span className="text-xs text-gray-500">字體</span>
            <div className="grid grid-cols-2 gap-1.5">
              {FONTS.map(f => (
                <button
                  key={f.value}
                  onClick={() => onChange({ font_family: f.value })}
                  style={{ fontFamily: f.css, fontWeight: f.bold ? "bold" : "normal" }}
                  className={`px-2 py-1.5 rounded border text-sm text-left truncate transition-colors ${
                    item.font_family === f.value
                      ? "border-indigo-500 bg-indigo-50 text-indigo-700"
                      : "border-gray-200 hover:border-gray-300 text-gray-700"
                  }`}
                >
                  {f.label}
                </button>
              ))}
            </div>
          </label>

          {/* Font size */}
          <label className="flex flex-col gap-1">
            <span className="text-xs text-gray-500">字級（pt）</span>
            <div className="flex items-center gap-2">
              <input
                type="range" min="10" max="72" step="1"
                value={item.font_size ?? 20}
                onChange={e => onChange({ font_size: Number(e.target.value) })}
                className="flex-1"
              />
              <input
                type="number" min="10" max="72"
                value={item.font_size ?? 20}
                onChange={e => onChange({ font_size: Number(e.target.value) })}
                className="border rounded px-1 py-1 text-sm w-14 text-center"
              />
            </div>
          </label>

          <ColorPicker
            label="文字顏色"
            value={item.font_color ?? "#333333"}
            onChange={v => onChange({ font_color: v })}
          />

          {/* Border */}
          <div className="space-y-2 pt-1 border-t border-gray-100">
            <span className="text-xs text-gray-500 block">外框</span>
            <div className="flex items-center gap-3">
              <label className="flex items-center gap-1.5 text-sm">
                <input
                  type="checkbox"
                  checked={!!(item.border_color && (item.border_width ?? 0) > 0)}
                  onChange={e => onChange(e.target.checked
                    ? { border_color: item.border_color || "#555555", border_width: item.border_width || 2 }
                    : { border_color: null, border_width: 0 }
                  )}
                />
                顯示外框
              </label>
              {item.border_color && (item.border_width ?? 0) > 0 && (
                <label className="flex items-center gap-1 text-xs text-gray-500 ml-auto">
                  粗細
                  <input
                    type="number" min="1" max="20"
                    value={item.border_width ?? 2}
                    onChange={e => onChange({ border_width: Number(e.target.value) })}
                    className="border rounded px-1 py-0.5 text-sm w-14 text-center"
                  />
                </label>
              )}
            </div>
            {item.border_color && (item.border_width ?? 0) > 0 && (
              <ColorPicker
                value={item.border_color ?? "#555555"}
                onChange={v => onChange({ border_color: v })}
              />
            )}
          </div>
        </>
      )}
    </div>
  );
}
