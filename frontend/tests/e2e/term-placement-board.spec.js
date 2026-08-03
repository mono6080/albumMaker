// 編班看板的互動契約：真實拖曳、框選、老師搬動與升主教、班級增刪改名與排序、
// 跨分校搬動。這些都是「不會報錯、只會做錯」的操作，靠 API 測不出來。
import { expect, test } from "./fixtures.js";

import { cancelLeftoverTermPlan, loginViaApi } from "./helpers.js";


async function readJson(response, operation) {
  const text = await response.text();
  expect(response.ok(), `${operation} 回應 ${response.status()}: ${text}`).toBeTruthy();
  return JSON.parse(text);
}


// dnd-kit 的 MouseSensor 需要 4px 以上的移動才啟動；一步到位的 dragTo 不會觸發，
// 所以自己送 down → 多段 move → up。
async function dragTo(page, source, target, { steps = 12 } = {}) {
  // 捲到畫面正中，不是「剛好進入可視區」：dnd-kit 的自動捲動在指標靠近視窗邊緣時
  // 就會啟動，而 scrollIntoViewIfNeeded 只做最小捲動，元素正好停在那個觸發區。
  await source.evaluate(node => node.scrollIntoView({ block: "center", inline: "center" }));
  await page.waitForTimeout(120);
  const from = await source.boundingBox();
  expect(from, "拖曳來源不在畫面上").toBeTruthy();

  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  // 超過 4px 才會啟動拖曳
  await page.mouse.move(from.x + from.width / 2 + 12, from.y + from.height / 2, { steps: 3 });
  await page.waitForTimeout(120);

  // 目標座標必須在拖曳**開始之後**才量：dnd-kit 的自動捲動會在指標靠近邊緣時
  // 捲動畫面，事先量好的座標就指到別的地方，mouseup 落在空白處而靜靜地不落地。
  const to = await target.boundingBox();
  expect(to, "拖曳目標不在畫面上").toBeTruthy();
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps });
  await page.waitForTimeout(120);
  // 再量一次並校正：這一段移動本身也可能觸發自動捲動
  const settled = await target.boundingBox();
  if (settled) {
    await page.mouse.move(settled.x + settled.width / 2, settled.y + settled.height / 2, {
      steps: 3,
    });
    await page.waitForTimeout(120);
  }
  await page.mouse.up();
}


test("編班看板：拖曳、框選、老師搬動與班級維護", async ({ page }) => {
  test.slow();
  const suffix = Math.random().toString(36).slice(2, 10);
  await loginViaApi(page);

  const campusName = `看板校 ${suffix}`;
  const otherCampusName = `看板他校 ${suffix}`;
  const sourceClassName = `來源班 ${suffix}`;
  const targetClassName = `目標班 ${suffix}`;
  const otherClassName = `他校班 ${suffix}`;

  const campus = await readJson(
    await page.request.post("/api/organization/campuses", { data: { name: campusName } }),
    "建立分校",
  );
  const otherCampus = await readJson(
    await page.request.post("/api/organization/campuses", { data: { name: otherCampusName } }),
    "建立第二分校",
  );

  const createClassroom = async (campusId, name) => readJson(
    await page.request.post("/api/organization/classrooms", {
      data: { campus_id: campusId, department: "infant", name },
    }),
    `建立班級 ${name}`,
  );
  const sourceClassroom = await createClassroom(campus.id, sourceClassName);
  await createClassroom(campus.id, targetClassName);
  const otherClassroom = await createClassroom(otherCampus.id, otherClassName);

  const studentNames = ["甲生", "乙生", "丙生", "丁生"].map(name => `${name}${suffix}`);
  await readJson(
    await page.request.post(
      `/api/organization/classrooms/${sourceClassroom.id}/members/batch`,
      { data: { members: studentNames.map(name => ({ name })) } },
    ),
    "建立來源班名單",
  );
  await readJson(
    await page.request.post(
      `/api/organization/classrooms/${otherClassroom.id}/members/batch`,
      { data: { members: [{ name: `他校生${suffix}` }] } },
    ),
    "建立他校名單",
  );

  const createTeacher = async (label) => readJson(
    await page.request.post("/api/users/", {
      data: {
        username: `board-${label}-${suffix}`,
        display_name: `${label}老師${suffix}`,
        password: "board-teacher-password",
        role: "teacher",
      },
    }),
    `建立老師 ${label}`,
  );
  const lead = await createTeacher("主");
  const assistant = await createTeacher("協");
  await readJson(
    await page.request.put(
      `/api/organization/classrooms/${sourceClassroom.id}/teachers`,
      {
        data: {
          teachers: [
            { teacher_id: lead.id, duty: "lead" },
            { teacher_id: assistant.id, duty: "co_teacher" },
          ],
        },
      },
    ),
    "設定來源班編制",
  );

  await cancelLeftoverTermPlan(page);
  const plan = await readJson(
    await page.request.post("/api/organization/term-reclassification-plans", {
      data: { label: `看板驗收 ${suffix}` },
    }),
    "建立編班草稿",
  );
  const targetClassroomId = name => plan.target_classrooms.find(
    row => row.name === name,
  ).classroom_id;

  await page.goto("/admin/organization/new-term");
  await expect(page.getByRole("heading", { name: `看板驗收 ${suffix}`, exact: true })).toBeVisible();

  const board = page.locator("#term-board");
  const studentCard = name => board.getByRole("button", { name, exact: true });
  const column = name => board.locator(`#term-classroom-${targetClassroomId(name)}`);
  // 草稿裡新開的班不在建立當下的 plan 快照裡，只能用標題的無障礙名稱指認
  const columnNamed = (campus, name) => board.locator('[id^="term-classroom-"]').filter({
    has: page.getByRole("button", {
      name: new RegExp(`^(重新命名|放進) ${campus}／${name}$`),
    }),
  });
  const columnHeader = name => page.getByRole("button", {
    name: new RegExp(`^(重新命名|放進) ${campusName}／${name}$`),
  });
  const openCampusTab = campus => page.getByRole("button", {
    name: `切換到 ${campus}`,
  }).click();

  await openCampusTab(campusName);
  await expect(studentCard(studentNames[0])).toBeVisible();

  // 1) 真實拖曳一位學生換班
  await dragTo(page, studentCard(studentNames[0]), column(targetClassName));
  await expect(column(targetClassName).getByText(studentNames[0], { exact: true })).toBeVisible();

  // 2) 框選：從欄位之間的間隙起拉（起點必須不是卡片，否則會被當成拖曳搬動），
  //    框住來源班剩下的學生
  const sourceColumn = column(sourceClassName);
  await sourceColumn.evaluate(node => node.scrollIntoView({ block: "center", inline: "center" }));
  await page.waitForTimeout(120);
  const sourceBox = await sourceColumn.boundingBox();
  const remainingCards = sourceColumn.locator('[id^="term-student-"]');
  const firstCard = await remainingCards.first().boundingBox();
  const lastCard = await remainingCards.last().boundingBox();
  await page.mouse.move(sourceBox.x + sourceBox.width + 4, firstCard.y - 6);
  await page.mouse.down();
  await page.mouse.move(sourceBox.x + sourceBox.width - 20, firstCard.y + 4, { steps: 4 });
  await page.mouse.move(sourceBox.x + 4, lastCard.y + lastCard.height + 6, { steps: 10 });
  await page.mouse.up();
  await expect(page.getByText(/已選取 [23] 位學生/)).toBeVisible();
  // 框選不該把姓名反白
  expect(await page.evaluate(() => window.getSelection().toString())).toBe("");

  // 3) 拖曳其中一張已選取的卡片：整批一起搬，含被按住的那一位
  const pickedName = await board.locator('[id^="term-student-"][class*="ring-2"]')
    .first().innerText();
  await dragTo(
    page,
    board.getByRole("button", { name: pickedName.trim(), exact: true }),
    column(targetClassName),
  );
  await expect(column(targetClassName).getByText(pickedName.trim(), { exact: true })).toBeVisible();

  // 4) × 標記離園
  const departing = studentNames[studentNames.length - 1];
  const departButton = page.getByRole("button", { name: `把 ${departing} 標記為離園` });
  if (await departButton.count()) {
    await departButton.click();
    await expect(
      board.getByRole("button", { name: /^(重新命名|放進) 離園$/ }),
    ).toBeVisible();
  }

  // 5) 老師拖到沒有主教的班 → 成為主教
  // 老師區有兩個按鈕：可拖曳的標籤（帶 aria-pressed）與切換主教的「主／協」徽章
  const leadChip = board.locator("button[aria-pressed]")
    .filter({ hasText: `主老師${suffix}` });
  await dragTo(page, leadChip, column(targetClassName));
  await expect(
    column(targetClassName).getByRole("button", { name: `主老師${suffix} 目前是主教` }),
  ).toBeVisible();
  // 來源班只剩協同時要自動遞補主教，否則後端驗證必定失敗
  await expect(
    column(sourceClassName).getByRole("button", { name: `協老師${suffix} 目前是主教` }),
  ).toBeVisible();

  // 6) 班級改名：點班名就地編輯，輸入框進來就全選
  const renamed = `改名後 ${suffix}`;
  await columnHeader(targetClassName).click();
  const renameInput = page.getByLabel(`班級名稱 ${targetClassName}`);
  await expect(renameInput).toBeFocused();
  await renameInput.fill(renamed);
  await renameInput.press("Enter");
  await expect(page.getByRole("button", {
    name: new RegExp(`^(重新命名|放進) ${campusName}／${renamed}$`),
  })).toBeVisible();

  // 7) 排序：往前移一格之後順序真的變了
  const columnOrder = async () => board.locator('[id^="term-classroom-"]')
    .evaluateAll(nodes => nodes.map(node => node.id));
  const before = await columnOrder();
  await page.getByRole("button", { name: `把 ${campusName}／${renamed} 往前移一格` }).click();
  await expect.poll(columnOrder).not.toEqual(before);

  // 8) 新增班級 → 必須出現在老師編制裡（否則套用後是無人帶班的空班）→ 再移除
  await page.getByRole("button", { name: "儲存草稿" }).click();
  await expect(page.getByText("編班草稿已儲存").first()).toBeVisible();
  await page.getByRole("button", { name: `在${campusName}新增班級` }).click();
  const addedName = `新開班 ${suffix}`;
  await page.getByLabel("班級名稱").fill(addedName);
  await page.getByRole("button", { name: "新增", exact: true }).click();
  await expect(page.getByText("已新增新學期班級")).toBeVisible();
  const addedColumn = board.locator("div").filter({ hasText: addedName }).first();
  await expect(addedColumn).toBeVisible();
  await expect(
    page.getByRole("button", { name: `調整 ${campusName}／${addedName} 的老師` }),
  ).toBeVisible();
  // 8a) 拖進**空**班級：空欄只有標題＋96px 的放置區，用面積判定的 rectIntersection
  //     會把它判給旁邊比較高的欄（尤其最後一欄「離園」），學生就被靜靜搬去離園。
  //     2026-08 照行政系統演練 115 上時，465 位裡有 7 位是這樣跑掉的。
  const departedCount = () => board
    .locator('[id^="term-classroom-"]').filter({ hasText: "離園" })
    .locator('[id^="term-student-"]').count();
  const departedBefore = await departedCount();
  const movedIn = await column(targetClassName).locator('[id^="term-student-"]')
    .first().innerText();
  await dragTo(
    page,
    board.getByRole("button", { name: movedIn.trim(), exact: true }),
    columnNamed(campusName, addedName),
  );
  await expect(
    columnNamed(campusName, addedName).getByText(movedIn.trim(), { exact: true }),
  ).toBeVisible();
  expect(await departedCount(), "拖進空班時不該有人被丟進離園").toBe(departedBefore);

  // 8b) 新生：名冊裡還沒有的孩子，草稿階段就要能編進新學期的班。
  //     編入新生會重載草稿，所以未儲存的編輯必須先存起來（UI 也是這樣擋的）。
  await page.getByRole("button", { name: "儲存草稿" }).click();
  await expect(page.getByText("編班草稿已儲存").first()).toBeVisible();
  const newcomer = `新生${suffix}`;
  const newcomerWithoutSerial = `無學號${suffix}`;
  await page.getByRole("button", { name: `在 ${campusName}／${addedName} 新增新生` }).click();
  // 學號是與行政系統對帳的唯一鍵；沒有它，這位孩子在名冊同步裡永遠對不到上游。
  // 一次驗兩種：帶學號的正常編入，沒帶的仍可編入但要在看板上標示出來。
  // 故意用小寫送出：學號會被正規化成大寫，同一個孩子才不會因為大小寫對不上
  const newcomerSerial = `DN${suffix}`;
  await page.getByLabel(/^姓名/).fill(`${newcomer}	${newcomerSerial}
${newcomerWithoutSerial}`);
  await page.getByRole("button", { name: "編入", exact: true }).click();
  await expect(page.getByText(/已編入 2 位新生/)).toBeVisible();
  await expect(columnNamed(campusName, addedName).getByText(newcomer, { exact: true })).toBeVisible();
  await expect(
    columnNamed(campusName, addedName).getByTitle(`${newcomer}（新生，學號 ${newcomerSerial.toUpperCase()}）`),
  ).toBeVisible();
  await expect(
    columnNamed(campusName, addedName).getByLabel(`${newcomerWithoutSerial} 沒有學號`),
  ).toBeVisible();
  await page.getByRole("button", { name: `移除新生 ${newcomerWithoutSerial}` }).click();
  await expect(page.getByText(`已移除新生 ${newcomerWithoutSerial}`)).toBeVisible();
  // 新生沒有來源名單列，不能拖也不能標離園——只有「移除新生」
  await expect(
    columnNamed(campusName, addedName).getByRole("button", { name: `把 ${newcomer} 標記為離園` }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: `移除新生 ${newcomer}` }).click();
  await expect(page.getByText(`已移除新生 ${newcomer}`)).toBeVisible();

  // 把剛拖進去的學生搬回來，空班才移除得掉
  await dragTo(
    page,
    board.getByRole("button", { name: movedIn.trim(), exact: true }),
    column(targetClassName),
  );
  await page.getByRole("button", { name: "儲存草稿" }).click();
  await expect(page.getByText("編班草稿已儲存").first()).toBeVisible();
  await page.getByRole("button", { name: `移除班級 ${campusName}／${addedName}` }).click();
  await expect(page.getByText("已移除新學期班級")).toBeVisible();

  // 9) 跨分校搬動：選取狀態要跨分頁保留
  const remaining = await board.locator('[id^="term-student-"]').first().innerText();
  await board.getByRole("button", { name: remaining.trim(), exact: true }).click();
  await expect(page.getByText(/已選取 1 位學生/)).toBeVisible();
  await openCampusTab(otherCampusName);
  await expect(page.getByText(/已選取 1 位學生/)).toBeVisible();
  await page.getByRole("button", {
    name: new RegExp(`^(重新命名|放進) ${otherCampusName}／${otherClassName}$`),
  }).click();
  await expect(
    board.getByRole("button", { name: remaining.trim(), exact: true }),
  ).toBeVisible();
});
