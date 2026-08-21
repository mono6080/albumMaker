import "./api.test.mjs";
import "./api-error.test.mjs";
import "./organization-api.test.mjs";
import "./editor-fonts.test.mjs";
import "./photos.test.mjs";
import "./photo-save.test.mjs";
import "./latest-request.test.mjs";
import "./layout-history.test.mjs";
import "./preview-cache.test.mjs";
import "./camera.test.mjs";
import "./render.test.mjs";
import "./layers.test.mjs";
import "./selection.test.mjs";
import "./duplication.test.mjs";
import "./groups-contract.test.mjs";
import "./groups-commands.test.mjs";
import "./groups-nested.test.mjs";
import "./text.test.mjs";
import "./text-progress.test.mjs";
import "./roles.test.mjs";
import "./classroom-assignments.test.mjs";
import "./roster-member-input.test.mjs";

import { runTests } from "./harness.mjs";


await runTests();
