import "./api.test.mjs";
import "./photos.test.mjs";
import "./photo-save.test.mjs";
import "./camera.test.mjs";
import "./render.test.mjs";
import "./layers.test.mjs";
import "./selection.test.mjs";
import "./duplication.test.mjs";
import "./groups-contract.test.mjs";
import "./groups-commands.test.mjs";
import "./groups-nested.test.mjs";
import "./text.test.mjs";
import "./roles.test.mjs";

import { runTests } from "./harness.mjs";


await runTests();
