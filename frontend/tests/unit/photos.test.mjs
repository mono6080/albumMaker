import assert from "node:assert/strict";
import {
  buildItems,
  clampPan,
  getPhotoCropBox,
  normalizePhotoData,
  photoDims,
} from "../../src/utils/photoUtils.js";
import { PHOTO_SLOT_CONTENT_BOX_MODE, getPhotoContentRect, getPhotoFrameRect } from "../../src/utils/photoFrameGeometry.js";
import { matchPersonalFilesToSlots, matchByNamePageSlot, matchByNameSlotSequence } from "../../src/utils/photoMatcher.js";
import { test } from "./harness.mjs";


test("photo utilities normalize records and build slot items", () => {
  assert.deepEqual(normalizePhotoData(null), null);
  assert.deepEqual(normalizePhotoData("projects/p.jpg"), {
    path: "projects/p.jpg",
    scale: 1.0,
    offsetX: 0,
    offsetY: 0,
    brightness: 1.0,
    contrast: 1.0,
  });
  assert.deepEqual(normalizePhotoData({ path: "projects/p.jpg", scale: 1.4, offset_x: -0.2, offset_y: 0.3 }), {
    path: "projects/p.jpg",
    scale: 1.4,
    offsetX: -0.2,
    offsetY: 0.3,
    brightness: 1.0,
    contrast: 1.0,
  });
  assert.deepEqual(
    normalizePhotoData({ path: "projects/p.jpg", scale: 1, offset_x: 0, offset_y: 0, brightness: 1.3, contrast: 0.9 }),
    { path: "projects/p.jpg", scale: 1, offsetX: 0, offsetY: 0, brightness: 1.3, contrast: 0.9 },
  );

  const items = buildItems(
    [
      { pi: 0, slotId: 1, slotIndex: 0, slotW: 320, slotH: 240, border: true, borderW: 10 },
      { pi: 1, slotId: 2, slotIndex: 0 },
    ],
    {
      pages_data: [
        {
          page_index: 0,
          photos: {
            "1": { path: "projects/p.jpg", scale: 1.2, offset_x: 0.1, offset_y: -0.1 },
          },
        },
      ],
    },
  );

  assert.equal(items[0].serverPath, "projects/p.jpg");
  assert.deepEqual(items[0].transform, { scale: 1.2, offsetX: 0.1, offsetY: -0.1, brightness: 1.0, contrast: 1.0 });
  assert.equal(items[0].slotW, 320);
  assert.equal(items[0].border, true);
  assert.equal(items[1].serverPath, null);
  assert.deepEqual(items[1].transform, { scale: 1.0, offsetX: 0, offsetY: 0, brightness: 1.0, contrast: 1.0 });
});


test("photo sizing cover-fits the crop box and clamps visible overflow", () => {
  assert.deepEqual(photoDims(100, 100, 2, 1), { w: 200, h: 100 });
  assert.deepEqual(photoDims(100, 100, 0.5, 1), { w: 100, h: 200 });
  assert.deepEqual(photoDims(200, 100, 1.5, 1), { w: 200, h: 133.33333333333334 });
  assert.deepEqual(photoDims(100, 200, 0.75, 1), { w: 150, h: 200 });
  assert.deepEqual(clampPan(200, -200, 100, 100, 2, 1), { panX: 50, panY: -0 });
  assert.deepEqual(clampPan(-200, 200, 100, 100, 0.5, 1), { panX: -0, panY: 50 });
  assert.deepEqual(clampPan(200, 200, 200, 100, 1.5, 1), { panX: 0, panY: 16.66666666666667 });
});


test("photo crop boxes match backend bordered slot geometry", () => {
  assert.deepEqual(getPhotoCropBox({ slotW: 150, slotH: 120, border: true, borderW: 8 }), {
    x: 8,
    y: 8,
    right: 8,
    bottom: 24,
    width: 134,
    height: 88,
  });
  assert.deepEqual(getPhotoCropBox({ slotW: 150, slotH: 120, border: false, borderW: 8 }), {
    x: 0,
    y: 0,
    right: 0,
    bottom: 0,
    width: 150,
    height: 120,
  });
});


test("photo frame geometry supports migrated content-box layouts", () => {
  const frameSlot = { x: 40, y: 52, width: 150, height: 120, border: true, border_width: 8 };
  const contentRect = getPhotoContentRect(frameSlot);
  assert.deepEqual(contentRect, { x: 48, y: 60, width: 134, height: 88 });

  const contentSlot = {
    ...contentRect,
    border: true,
    border_width: 8,
    dimensionMode: PHOTO_SLOT_CONTENT_BOX_MODE,
  };
  assert.deepEqual(getPhotoFrameRect(contentSlot), { x: 40, y: 52, width: 150, height: 120 });
  assert.deepEqual(getPhotoCropBox({
    slotW: contentRect.width,
    slotH: contentRect.height,
    border: true,
    borderW: 8,
    dimensionMode: PHOTO_SLOT_CONTENT_BOX_MODE,
  }), {
    x: 8,
    y: 8,
    right: 8,
    bottom: 24,
    width: 134,
    height: 88,
  });
});


test("photo matcher maps filenames to explicit page-slot targets", () => {
  const students = [
    { id: 1, name: "王小明", order_index: 0 },
    { id: 2, name: "小明", order_index: 1 },
    { id: 3, name: "陳美花", order_index: 2 },
  ];
  const pages = [
    { layout: { photo_slots: [{ id: 101 }, { id: 102 }] } },
    { layout: { photo_slots: [{ id: 201 }] } },
  ];
  const file = (name) => ({ name });
  const files = [
    file("王小明1-1.jpg"),
    file("王小明1-2.heic"),
    file("小明2-1.png"),
    file("王小明9-9.jpg"),
    file("阿華1-1.jpg"),
  ];

  const result = matchByNamePageSlot(students, files, pages);
  assert.deepEqual(
    result.assignments.map(({ studentId, pageIndex, slotId, file }) => `${studentId}:${pageIndex}:${slotId}:${file.name}`),
    [
      "1:0:101:王小明1-1.jpg",
      "1:0:102:王小明1-2.heic",
      "2:1:201:小明2-1.png",
    ],
  );
  assert.deepEqual(result.unmatched, [3]);
  assert.deepEqual(result.invalid.map(({ file, reason }) => `${file.name}:${reason}`), [
    "王小明9-9.jpg:找不到對應照片格",
    "阿華1-1.jpg:找不到學生姓名",
  ]);
  assert.deepEqual(result.unused.map((item) => item.name), ["王小明9-9.jpg", "阿華1-1.jpg"]);
});


test("photo matcher maps filenames to global slot sequence targets", () => {
  const students = [
    { id: 1, name: "王小明", order_index: 0 },
    { id: 2, name: "小明", order_index: 1 },
  ];
  const pages = [
    { layout: { photo_slots: [{ id: 101 }, { id: 102 }] } },
    { layout: { photo_slots: [{ id: 201 }] } },
  ];
  const file = (name) => ({ name });
  const files = [
    file("王小明1.jpg"),
    file("王小明02.jpg"),
    file("小明3.png"),
    file("王小明01.heic"),
    file("小明4.jpg"),
  ];

  const result = matchByNameSlotSequence(students, files, pages);
  assert.deepEqual(
    result.assignments.map(({ studentId, pageIndex, slotId, file }) => `${studentId}:${pageIndex}:${slotId}:${file.name}`),
    [
      "1:0:101:王小明1.jpg",
      "1:0:102:王小明02.jpg",
      "2:1:201:小明3.png",
    ],
  );
  assert.deepEqual(result.invalid.map(({ file, reason }) => `${file.name}:${reason}`), [
    "王小明01.heic:同一學生同一格重複配對",
    "小明4.jpg:找不到對應照片格",
  ]);
  assert.deepEqual(result.unused.map((item) => item.name), ["王小明01.heic", "小明4.jpg"]);
});


test("photo matcher maps personal multi-upload filenames by numeric suffix only", () => {
  const pages = [
    { layout: { photo_slots: [{ id: 101 }, { id: 102 }] } },
    { layout: { photo_slots: [{ id: 201 }] } },
  ];
  const file = (name) => ({ name });
  const files = [
    file("王小明1-2.jpg"),
    file("王小明3.heic"),
    file("1-1.png"),
    file("生活照.jpg"),
    file("王小明.jpg"),
    file("王小明4.jpg"),
  ];

  const result = matchPersonalFilesToSlots(files, pages);
  assert.deepEqual(
    result.assignments.map(({ pageIndex, slotId, file }) => `${pageIndex}:${slotId}:${file.name}`),
    [
      "0:102:王小明1-2.jpg",
      "1:201:王小明3.heic",
      "0:101:1-1.png",
    ],
  );
  assert.deepEqual(result.unused.map((item) => item.name), ["生活照.jpg", "王小明.jpg"]);
  assert.deepEqual(result.invalid.map(({ file, reason }) => `${file.name}:${reason}`), [
    "王小明4.jpg:找不到對應照片格",
  ]);
});
