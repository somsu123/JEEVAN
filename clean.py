import re

path = 'd:\\Elder--Care\\dashboard-v2\\src\\components\\LiveVitals.tsx'
with open(path, 'r', encoding='utf-8') as f:
    content = f.read()

# Update props interface
content = re.sub(r'  braceletOnline\?: boolean;\n  braceletBpm\?: number \| null;\n  fingerPresent\?: boolean;\n', '', content)

# Remove BPMSparkline
content = re.sub(r'// ─── BPM Sparkline \(pure SVG, no external libs\) ──────────────────────────────\nfunction BPMSparkline.*?(?=// ─── Status color utilities)', '', content, flags=re.DOTALL)

# Remove bpmStatus
content = re.sub(r'function bpmStatus.*?(?=function spo2Status)', '', content, flags=re.DOTALL)

# Remove BPM component parameters from export default function
content = re.sub(r'hardwareOnline, braceletOnline = false, braceletBpm = null, fingerPresent = false', 'hardwareOnline', content)

# Remove local BPM vars
content = re.sub(r'  // Use real bracelet BPM or 0 — never show fake numbers\n  const displayBpm.*?(?=  const spo2St)', '', content, flags=re.DOTALL)

# Remove bracelet indicator badges
content = re.sub(r'          \{braceletOnline \? \([\s\S]*?            \)\}\n', '', content)

# Remove BPM Hero Card
content = re.sub(r'      \{/\* ── BPM Hero Card ── \*/\}.*?(?=      \{/\* ── Vitals Grid ── \*/\})', '', content, flags=re.DOTALL)

with open(path, 'w', encoding='utf-8') as f:
    f.write(content)
