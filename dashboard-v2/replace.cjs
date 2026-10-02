const fs = require('fs');
let text = fs.readFileSync('server.ts', 'utf8');
const target = `    // -- Step 6: Build markdown summary focused on medicines
    let summaryText = \`## Prescribed Medications\\n\`;
    if (Array.isArray(schemaData.medicines) && schemaData.medicines.length > 0) {
      schemaData.medicines.forEach((m: any) => {
        const timeList = Array.isArray(m.times) ? m.times.join(", ") : "";
        const timeStr = timeList ? \` at \${timeList}\` : "";
        const purposeStr = m.purpose ? \` -- *\${m.purpose}*\` : "";
        summaryText += \`* **\${m.name}**\${m.dosage ? \` (\${m.dosage})\` : ""}\${timeStr}\${purposeStr}\\n\`;
      });
    } else {
      summaryText += "* No medications identified in this document.\\n";
    }
    summaryText += \`\\n## Summary\\n\${schemaData.overview}\\n\`;`;

const replacement = `    // -- Step 6: Build markdown clinical summary
    let summaryText = \`## Document Overview\\n\${schemaData.overview || "Document scan complete."}\\n\`;
    
    if (schemaData.metrics && schemaData.metrics.length > 0) {
      summaryText += \`\\n## Key Metrics & Readings\\n\`;
      schemaData.metrics.forEach((m: any) => {
        summaryText += \`* **\${m.name}**: \${m.value} (\${m.status}) — *\${m.interpretation}*\\n\`;
      });
    }`;

const normalize = str => str.replace(/\r\n/g, '\n');
if (normalize(text).includes(normalize(target))) {
    text = normalize(text).replace(normalize(target), replacement);
    fs.writeFileSync('server.ts', text);
    console.log("Success");
} else {
    console.log("Not found!");
}
