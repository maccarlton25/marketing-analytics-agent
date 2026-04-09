import { executeInSandbox } from "../lib/sandbox";
import * as fs from "fs";

const csv = `region,revenue\nNorth,1200\nSouth,900\nEast,1500\nWest,800`;
const code = `
ax = df.plot(kind='bar', x='region', y='revenue', title='Revenue by Region', legend=False)
ax.set_xlabel('Region')
ax.set_ylabel('Revenue ($)')
`;

async function main() {
  const result = await executeInSandbox(csv, code);
  if (result.success) {
    fs.writeFileSync(
      "test-chart.png",
      Buffer.from(result.imageBase64!, "base64"),
    );
    console.log(`Success in ${result.durationMs}ms. Saved to test-chart.png`);
  } else {
    console.error("Failed:", result.error);
  }
}

main().catch(console.error);
