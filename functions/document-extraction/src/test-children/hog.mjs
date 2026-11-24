const held = [];
for (let allocated = 0; allocated < 1024 * 1024 * 1024; allocated += 16 * 1024 * 1024) {
  held.push(Buffer.alloc(16 * 1024 * 1024, 1));
  await new Promise((resolve) => setTimeout(resolve, 20));
}
process.stdout.write(
  `${JSON.stringify({ status: "unusable", reason: "unreadable", detail: `survived holding ${held.length} buffers` })}\n`,
);
