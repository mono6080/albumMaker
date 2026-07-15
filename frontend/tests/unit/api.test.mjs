import assert from "node:assert/strict";
import {
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
  buildTemplatePagePreviewUrl,
  buildTemplateSpreadPreviewUrl,
} from "../../src/api/urls.js";
import { apiClient } from "../../src/api/authApi.js";
import { fetchProjectTemplatePair } from "../../src/api/templateApi.js";
import { getApiPath, getFilenameFromDisposition, isMobileDevice } from "../../src/utils/browserFiles.js";
import { test } from "./harness.mjs";


test("API URL builders keep route contracts stable", () => {
  assert.equal(buildTemplatePagePreviewUrl(1, 2), "/api/templates/1/pages/2/preview");
  assert.equal(buildTemplateSpreadPreviewUrl(1, 0), "/api/templates/1/spread-preview/0");
  assert.equal(buildStickerUrl(1, "star.png"), "/api/templates/1/stickers/star.png");
  assert.equal(buildProjectPagePreviewUrl(3, 0), "/api/projects/3/preview/0");
  assert.equal(buildStudentPagePreviewUrl(3, 4, 1), "/api/projects/3/students/4/preview/1");
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
