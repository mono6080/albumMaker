"""
Test flow for 複製原始PDF - album maker web app
"""
import asyncio
import os
from pathlib import Path
from playwright.async_api import async_playwright

SCREENSHOTS_DIR = Path("D:/projects/album_maker/backend/test_screenshots")
SCREENSHOTS_DIR.mkdir(exist_ok=True)

IMAGE_FILES = [
    r"D:\Downloads\新增資料夾 (5)\image3.JPG",
    r"D:\Downloads\新增資料夾 (5)\image4.JPG",
    r"D:\Downloads\新增資料夾 (5)\image6.jpg",
    r"D:\Downloads\新增資料夾 (5)\image7.jpeg",
    r"D:\Downloads\新增資料夾 (5)\image8.JPG",
    r"D:\Downloads\新增資料夾 (5)\image10.JPG",
    r"D:\Downloads\新增資料夾 (5)\image11.jpeg",
    r"D:\Downloads\新增資料夾 (5)\image12.jpg",
    r"D:\Downloads\新增資料夾 (5)\image14.jpg",
    r"D:\Downloads\新增資料夾 (5)\image15.JPG",
]

console_errors = []
console_all = []

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=False, slow_mo=200)
        context = await browser.new_context(viewport={"width": 1400, "height": 900})
        page = await context.new_page()

        # Capture console messages
        def on_console(msg):
            console_all.append(f"[{msg.type}] {msg.text}")
            if msg.type in ("error", "warning"):
                console_errors.append(f"[{msg.type}] {msg.text}")
        page.on("console", on_console)
        page.on("pageerror", lambda err: console_errors.append(f"[pageerror] {err}"))

        step = 0

        async def screenshot(name):
            nonlocal step
            step += 1
            path = str(SCREENSHOTS_DIR / f"{step:02d}_{name}.png")
            await page.screenshot(path=path, full_page=False)
            print(f"[screenshot] {step:02d}_{name}.png")

        async def dump_page_info():
            """Dump useful page info for debugging"""
            url = page.url
            title = await page.title()
            print(f"  URL: {url}")
            print(f"  Title: {title}")

        # --- Step 1: Navigate to /projects ---
        print("\n=== Step 1: Navigate to /projects ===")
        await page.goto("http://localhost:5173/projects")
        await page.wait_for_load_state("networkidle")
        await screenshot("projects_list")
        await dump_page_info()

        # --- Step 2: Navigate to batch edit for project 2 ---
        print("\n=== Step 2: Navigate to batch edit page for project 2 ===")
        await page.goto("http://localhost:5173/projects/2/batch")
        await page.wait_for_load_state("networkidle")
        await asyncio.sleep(1)
        await screenshot("batch_edit_page")
        await dump_page_info()

        # --- Step 3: Click on student 吳筠喬 ---
        print("\n=== Step 3: Click on student 吳筠喬 ===")
        student_el = page.get_by_text("吳筠喬")
        count = await student_el.count()
        print(f"Found '吳筠喬': {count} matches")
        if count > 0:
            await student_el.first.click()
            await asyncio.sleep(1.5)
            await screenshot("student_selected")
        else:
            print("ERROR: student not found")
            await screenshot("student_not_found")

        # --- Step 4: Inspect PhotoManager ---
        print("\n=== Step 4: Inspect PhotoManager ===")
        # Count images visible
        all_imgs = page.locator("img")
        img_count = await all_imgs.count()
        print(f"Total <img> elements: {img_count}")

        # Get all img srcs
        img_srcs = await page.evaluate("""() => {
            return Array.from(document.querySelectorAll('img')).map(img => ({
                src: img.src.substring(0, 100),
                alt: img.alt,
                width: img.naturalWidth,
                height: img.naturalHeight,
                class: img.className
            }));
        }""")
        print("Images on page:")
        for i, img in enumerate(img_srcs[:20]):
            print(f"  [{i}] {img['src']} (w={img['width']}, h={img['height']})")

        await screenshot("photo_manager_before_upload")

        # --- Step 5: Find the 多選上傳 button and its associated file input ---
        print("\n=== Step 5: Locate 多選上傳 button and file input ===")

        # Get all buttons text
        buttons_info = await page.evaluate("""() => {
            return Array.from(document.querySelectorAll('button')).map((btn, i) => ({
                index: i,
                text: btn.textContent.trim(),
                disabled: btn.disabled,
                class: btn.className.substring(0, 80)
            }));
        }""")
        print("Buttons on page:")
        for btn in buttons_info:
            print(f"  [{btn['index']}] '{btn['text']}' disabled={btn['disabled']}")

        # Get all file inputs
        file_inputs_info = await page.evaluate("""() => {
            return Array.from(document.querySelectorAll('input[type="file"]')).map((inp, i) => ({
                index: i,
                accept: inp.accept,
                multiple: inp.multiple,
                id: inp.id,
                name: inp.name,
                class: inp.className.substring(0, 80),
                parentText: inp.parentElement ? inp.parentElement.textContent.trim().substring(0, 50) : ''
            }));
        }""")
        print(f"\nFile inputs ({len(file_inputs_info)}):")
        for inp in file_inputs_info:
            print(f"  [{inp['index']}] id={inp['id']} multiple={inp['multiple']} accept={inp['accept']} parent='{inp['parentText']}'")

        # Valid files
        valid_files = [f for f in IMAGE_FILES if os.path.exists(f)]
        print(f"\nValid files: {len(valid_files)}")

        # Strategy: Click 多選上傳 button, then find its nearby file input
        # The button label probably triggers a hidden input
        upload_btn = page.get_by_text("多選上傳")
        upload_btn_count = await upload_btn.count()
        print(f"\n'多選上傳' button count: {upload_btn_count}")

        if upload_btn_count > 0:
            # Use file chooser to intercept the file dialog
            print("Setting up file chooser listener and clicking 多選上傳...")
            async with page.expect_file_chooser(timeout=5000) as fc_info:
                await upload_btn.first.click()
            file_chooser = await fc_info.value
            print(f"File chooser opened! is_multiple: {file_chooser.is_multiple()}")
            await file_chooser.set_files(valid_files)
            print("Files set via file chooser")
            await asyncio.sleep(3)
            await screenshot("after_file_chooser")
        else:
            print("ERROR: 多選上傳 button not found")
            # Fallback: set files directly on each file input and see which one reacts
            file_inputs = page.locator("input[type='file']")
            for i in range(await file_inputs.count()):
                fi = file_inputs.nth(i)
                await fi.set_input_files(valid_files)
                await asyncio.sleep(0.5)
            await screenshot("after_fallback_upload")

        # --- Step 6: Check state after file selection ---
        print("\n=== Step 6: Check state after file selection ===")
        await asyncio.sleep(2)

        # Re-check images
        img_srcs2 = await page.evaluate("""() => {
            return Array.from(document.querySelectorAll('img')).map(img => ({
                src: img.src.substring(0, 120),
                width: img.naturalWidth,
                height: img.naturalHeight
            }));
        }""")
        print(f"Images after upload ({len(img_srcs2)}):")
        for i, img in enumerate(img_srcs2[:25]):
            print(f"  [{i}] {img['src']} ({img['width']}x{img['height']})")

        # Check buttons state
        buttons_info2 = await page.evaluate("""() => {
            return Array.from(document.querySelectorAll('button')).map((btn, i) => ({
                index: i,
                text: btn.textContent.trim(),
                disabled: btn.disabled
            }));
        }""")
        print("\nButtons after upload:")
        for btn in buttons_info2:
            if btn['text']:
                print(f"  [{btn['index']}] '{btn['text']}' disabled={btn['disabled']}")

        await screenshot("after_upload_state")

        # --- Step 7: Click 確認儲存 if enabled ---
        print("\n=== Step 7: Click 確認儲存 ===")
        save_btn = page.get_by_text("確認儲存")
        save_count = await save_btn.count()
        print(f"'確認儲存' count: {save_count}")

        if save_count > 0:
            is_disabled = await save_btn.first.is_disabled()
            print(f"Button disabled: {is_disabled}")
            if not is_disabled:
                await save_btn.first.click()
                await asyncio.sleep(3)
                await page.wait_for_load_state("networkidle")
                await screenshot("after_save")
                print("Saved successfully")
            else:
                print("Save button is disabled - upload may not have worked correctly")
                await screenshot("save_button_disabled")
                # Try scrolling or looking for other indicators
                await page.evaluate("window.scrollTo(0, 0)")
                await asyncio.sleep(0.5)
                await screenshot("scrolled_to_top")
        else:
            print("No 確認儲存 button")
            await screenshot("no_save_button")

        # --- Step 8: Navigate to individual student page ---
        print("\n=== Step 8: Navigate to /projects/2/students/15 ===")
        await page.goto("http://localhost:5173/projects/2/students/15")
        await page.wait_for_load_state("networkidle")
        await asyncio.sleep(2)
        await screenshot("student_15_page")
        await dump_page_info()

        # Check images
        img_srcs3 = await page.evaluate("""() => {
            return Array.from(document.querySelectorAll('img')).map(img => ({
                src: img.src.substring(0, 120),
                width: img.naturalWidth,
                height: img.naturalHeight
            }));
        }""")
        print(f"Images on student page ({len(img_srcs3)}):")
        for i, img in enumerate(img_srcs3[:20]):
            print(f"  [{i}] {img['src']} ({img['width']}x{img['height']})")

        # --- Step 9: Click 產生 PDF ---
        print("\n=== Step 9: Click 產生 PDF ===")
        # Find PDF button
        buttons3 = await page.evaluate("""() => {
            return Array.from(document.querySelectorAll('button')).map((btn, i) => ({
                index: i,
                text: btn.textContent.trim(),
                disabled: btn.disabled
            }));
        }""")
        print("Buttons on student page:")
        for btn in buttons3:
            if btn['text']:
                print(f"  [{btn['index']}] '{btn['text']}' disabled={btn['disabled']}")

        # Try various PDF button selectors
        pdf_clicked = False
        for text_pattern in ["產生 PDF", "產生PDF", "生成PDF", "渲染", "Render"]:
            el = page.get_by_text(text_pattern, exact=False)
            if await el.count() > 0:
                print(f"Clicking '{text_pattern}' button")
                await el.first.click()
                pdf_clicked = True
                break

        if not pdf_clicked:
            # Try by button containing PDF
            el = page.locator("button", has_text="PDF")
            if await el.count() > 0:
                print("Clicking button containing 'PDF'")
                await el.first.click()
                pdf_clicked = True

        if pdf_clicked:
            print("Waiting for PDF render...")
            await asyncio.sleep(5)
            await screenshot("pdf_render_progress")
            await asyncio.sleep(5)
            await page.wait_for_load_state("networkidle")
            await screenshot("pdf_render_done")
        else:
            print("No PDF button found")
            await screenshot("no_pdf_button")

        # --- Final report ---
        print("\n" + "="*60)
        print("TEST COMPLETE - FINAL SUMMARY")
        print("="*60)

        print(f"\nTotal screenshots: {step}")
        print(f"\nConsole errors ({len(console_errors)}):")
        for err in console_errors[:30]:
            print(f"  {err}")

        print(f"\nAll console messages (last 20):")
        for msg in console_all[-20:]:
            print(f"  {msg}")

        print(f"\nScreenshots in: {SCREENSHOTS_DIR}")
        for f in sorted(SCREENSHOTS_DIR.iterdir()):
            print(f"  {f.name}")

        await asyncio.sleep(2)
        await browser.close()

if __name__ == "__main__":
    asyncio.run(main())
