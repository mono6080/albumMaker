const tests = [];


export function test(name, fn) {
  tests.push({ name, fn });
}


export async function runTests() {
  let failures = 0;

  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`ok - ${name}`);
    } catch (error) {
      failures += 1;
      console.error(`not ok - ${name}`);
      console.error(error);
    }
  }

  if (failures > 0) {
    process.exitCode = 1;
  }

  return { total: tests.length, failures };
}
