import { access, mkdir, mkdtemp, rename, rm, stat } from "node:fs/promises";
import path from "node:path";

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function assertNonEmpty(file) {
  const info = await stat(file);
  if (!info.isFile() || info.size < 1) throw new Error(`Output is empty: ${file}`);
}

export async function publishValidatedOutputs({ outputDir, base, writeCsv, writeXlsx }) {
  if (!base || path.basename(base) !== base) throw new Error("Output base name is invalid");
  await mkdir(outputDir, { recursive: true });
  const csvFile = path.join(outputDir, `${base}.csv`);
  const xlsxFile = path.join(outputDir, `${base}.xlsx`);
  if (await exists(csvFile) || await exists(xlsxFile)) throw new Error(`Output already exists: ${base}`);

  const tempDir = await mkdtemp(path.join(outputDir, `.${base}-`));
  const tempCsv = path.join(tempDir, `${base}.csv`);
  const tempXlsx = path.join(tempDir, `${base}.xlsx`);
  let publishedXlsx = false;
  let publishedCsv = false;
  try {
    await writeCsv(tempCsv);
    await writeXlsx(tempXlsx);
    await assertNonEmpty(tempCsv);
    await assertNonEmpty(tempXlsx);
    await rename(tempXlsx, xlsxFile);
    publishedXlsx = true;
    await rename(tempCsv, csvFile);
    publishedCsv = true;
    return { csvFile, xlsxFile };
  } catch (error) {
    if (publishedCsv) await rm(csvFile, { force: true });
    if (publishedXlsx) await rm(xlsxFile, { force: true });
    throw error;
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}
