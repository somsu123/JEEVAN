const fs = require('fs');
let content = fs.readFileSync('server.ts', 'utf8');

// Remove import
content = content.replace(/import nodemailer from "nodemailer";\r?\n/, '');

// Replace FallEmailAlert
const fallRegex = /async function sendFallEmailAlert\(event: FallEventRecord\) \{[\s\S]*?\n\}/;
content = content.replace(fallRegex, 'async function sendFallEmailAlert(event: FallEventRecord) {\n  // Removed\n}');

// Replace MissedDoseAlert
const doseRegex = /async function sendMissedDoseAlert\(medicine: string, time: string, dosage: string\) \{[\s\S]*?\n\}/;
content = content.replace(doseRegex, 'async function sendMissedDoseAlert(medicine: string, time: string, dosage: string) {\n  // Removed\n}');

fs.writeFileSync('server.ts', content);
console.log("Replaced email logic.");
