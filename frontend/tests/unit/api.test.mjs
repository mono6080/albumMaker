import assert from "node:assert/strict";
import {
  appendPreviewCacheVersion,
  buildDownloadAllImagesZipUrl,
  buildDownloadAllZipUrl,
  buildDownloadImageUrl,
  buildDownloadImagesZipUrl,
  buildDownloadPdfUrl,
  buildPhotoThumbnailUrl,
  buildPhotoUrl,
  buildProjectPagePreviewUrl,
  buildStickerUrl,
  buildStudentPagePreviewUrl,
  buildStudentAlbumNameAutoFillPath,
  buildStudentAlbumNamesAutoFillPath,
  buildTemplatePagePreviewUrl,
  buildTemplateSpreadPreviewUrl,
  PREVIEW_RENDER_BUILD_VERSION,
} from "../../src/api/urls.js";
import { apiClient } from "../../src/api/authApi.js";
import { updateStudentAlbumName } from "../../src/api/projectApi.js";
import { fetchProjectTemplatePair } from "../../src/api/templateApi.js";
import { getApiPath, getFilenameFromDisposition, isMobileDevice } from "../../src/utils/browserFiles.js";
import { test } from "./harness.mjs";


test("API URL builders keep route contracts stable", () => {
  const renderBuildQuery = `render_build=${encodeURIComponent(PREVIEW_RENDER_BUILD_VERSION)}`;
  assert.equal(buildTemplatePagePreviewUrl(1, 2), `/api/templates/1/pages/2/preview?${renderBuildQuery}`);
  assert.equal(buildTemplateSpreadPreviewUrl(1, 0), `/api/templates/1/spread-preview/0?${renderBuildQuery}`);
  assert.equal(buildStickerUrl(1, "star.png"), "/api/templates/1/stickers/star.png");
  assert.equal(buildProjectPagePreviewUrl(3, 0), `/api/projects/3/preview/0?${renderBuildQuery}`);
  assert.equal(
    buildStudentAlbumNamesAutoFillPath(3),
    "/projects/3/students/album-names/auto-fill",
  );
  assert.equal(
    buildStudentAlbumNameAutoFillPath(3, 4),
    "/projects/3/students/4/album-name/auto-fill",
  );
  assert.equal(buildStudentPagePreviewUrl(3, 4, 1), `/api/projects/3/students/4/preview/1?${renderBuildQuery}`);
  assert.equal(buildStudentPagePreviewUrl(3, 4, 1, 0.4), `/api/projects/3/students/4/preview/1?scale=0.4&${renderBuildQuery}`);
  assert.equal(
    appendPreviewCacheVersion(buildTemplateSpreadPreviewUrl(1, 0), 123, 7),
    `/api/templates/1/spread-preview/0?${renderBuildQuery}&t=123&template_revision=7`,
  );
  assert.equal(buildPhotoUrl(3, 4, 1, 9), "/api/projects/3/students/4/pages/1/photos/9");
  assert.equal(buildPhotoUrl(3, 4, 1, 9, "path/with space.png"), "/api/projects/3/students/4/pages/1/photos/9?v=path%2Fwith%20space.png");
  assert.equal(buildPhotoThumbnailUrl(3, 4, 1, 9), "/api/projects/3/students/4/pages/1/photos/9/thumbnail");
  assert.equal(buildPhotoThumbnailUrl(3, 4, 1, 9, "rev-2"), "/api/projects/3/students/4/pages/1/photos/9/thumbnail?v=rev-2");
  assert.equal(buildDownloadPdfUrl(3, 4), "/api/projects/3/students/4/pdf?mode=print");
  assert.equal(buildDownloadPdfUrl(3, 4, "screen"), "/api/projects/3/students/4/pdf?mode=screen");
  assert.equal(buildDownloadImagesZipUrl(3, 4), "/api/projects/3/students/4/images?mode=print");
  assert.equal(buildDownloadImagesZipUrl(3, 4, "screen"), "/api/projects/3/students/4/images?mode=screen");
  assert.equal(buildDownloadImageUrl(3, 4, 2), "/api/projects/3/students/4/images/2?mode=print");
  assert.equal(buildDownloadImageUrl(3, 4, 2, "screen"), "/api/projects/3/students/4/images/2?mode=screen");
  assert.equal(buildDownloadAllZipUrl(3, "screen"), "/api/projects/3/download/all?mode=screen");
  assert.equal(buildDownloadAllImagesZipUrl(3), "/api/projects/3/download/all/images?mode=print");
  assert.equal(buildDownloadAllImagesZipUrl(3, "screen"), "/api/projects/3/download/all/images?mode=screen");
});


test("project/template pair loader retries a revision split without poisoning cache", async () => {
  const originalGet = apiClient.get;
  let projectFetchCount = 0;
  let templateFetchCount = 0;
  apiClient.get = async (path) => {
    assert.equal(path, "/templates/987654321");
    templateFetchCount += 1;
    return { data: { id: 987654321, revision: 2, pages: [] } };
  };
  try {
    const result = await fetchProjectTemplatePair(async () => {
      projectFetchCount += 1;
      return {
        data: {
          id: 123456789,
          template_id: 987654321,
          template_revision: projectFetchCount === 1 ? 1 : 2,
        },
      };
    });
    assert.equal(result.projectData.template_revision, 2);
    assert.equal(result.templateResponse.data.revision, 2);
    assert.equal(projectFetchCount, 2);
    assert.equal(templateFetchCount, 2);
  } finally {
    apiClient.get = originalGet;
  }
});


test("project album name update uses the dedicated snapshot field contract", async () => {
  const originalPut = apiClient.put;
  const calls = [];
  apiClient.put = async (path, data) => {
    calls.push({ path, data });
    return { data: { ok: true } };
  };
  try {
    await updateStudentAlbumName(12, 34, "  小安  ");
    await updateStudentAlbumName(12, 34, "   ");
    assert.deepEqual(calls, [
      {
        path: "/projects/12/students/34/album-name",
        data: { album_name: "小安" },
      },
      {
        path: "/projects/12/students/34/album-name",
        data: { album_name: null },
      },
    ]);
  } finally {
    apiClient.put = originalPut;
  }
});


test("browser file helpers normalize API paths and download filenames", () => {
  assert.equal(getApiPath("/api/projects/1/download"), "/projects/1/download");
  assert.equal(getApiPath("/projects/1/download"), "/projects/1/download");
  assert.equal(
    getFilenameFromDisposition("attachment; filename*=UTF-8''%E7%9B%B8%E5%86%8A.jpg", "fallback.jpg"),
    "相冊.jpg",
  );
  assert.equal(
    getFilenameFromDisposition('attachment; filename="album.jpg"', "fallback.jpg"),
    "album.jpg",
  );
  assert.equal(getFilenameFromDisposition("", "fallback.jpg"), "fallback.jpg");
  assert.equal(isMobileDevice(), false);
});
