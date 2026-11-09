// Small concept dictionary for fake-embedding.server.ts to generate nearby vectors across languages; fixed material for tests and keyless development.
// Each concept lists phrases in nine languages. A phrase adds weight to the same concept dimension regardless of language, crudely approximating a real model's
// multilingual semantic similarity. Phrases are lowercased and NFKC-normalized. Match Latin-script phrases at word boundaries to avoid hitting parts of other words.
// Japanese, Chinese, Korean and Thai use substring matching because they lack word boundaries.
// Unknown words use hashed word dimensions, creating similarity only within the same language. Append new concepts at the end: ordering assigns dimensions.
export const EMBEDDING_CONCEPTS: ReadonlyArray<{ id: string; terms: readonly string[] }> = [
  { id: "cooperation", terms: ["cooperation", "cooperate", "協力", "協調", "coopération", "zusammenarbeit", "kooperation", "合作", "협력", "ความร่วมมือ", "hợp tác"] },
  { id: "symbiosis", terms: ["symbiosis", "symbiotic", "共生", "symbiose", "공생", "cộng sinh"] },
  { id: "control", terms: ["control", "制御", "contrôle", "kontrolle", "steuerung", "控制", "통제", "제어", "การควบคุม", "kiểm soát"] },
  { id: "alignment", terms: ["alignment", "アライメント", "alignement", "ausrichtung", "對齊", "对齐", "정렬", "การจัดแนว", "căn chỉnh"] },
  { id: "safety", terms: ["safety", "安全性", "sécurité", "sicherheit", "安全", "안전", "ความปลอดภัย", "an toàn"] },
  { id: "risk", terms: ["risk", "リスク", "危険", "risque", "risiko", "風險", "风险", "위험", "ความเสี่ยง", "rủi ro"] },
  { id: "values", terms: ["values", "価値観", "valeurs", "werte", "價值觀", "价值观", "가치관", "คุณค่า", "giá trị"] },
  { id: "translation", terms: ["translation", "翻訳", "traduction", "übersetzung", "翻譯", "翻译", "번역", "การแปล", "dịch thuật"] },
  { id: "diversity", terms: ["diversity", "多様性", "diversité", "vielfalt", "多元", "다양성", "ความหลากหลาย", "đa dạng"] },
  { id: "uncertainty", terms: ["uncertainty", "不確実性", "incertitude", "unsicherheit", "不確定性", "不确定性", "불확실성", "ความไม่แน่นอน", "bất định"] },
  { id: "governance", terms: ["governance", "ガバナンス", "gouvernance", "治理", "거버넌스", "การกำกับดูแล", "quản trị"] },
  { id: "interpretability", terms: ["interpretability", "解釈可能性", "interprétabilité", "interpretierbarkeit", "可解釋性", "可解释性", "해석 가능성", "ความสามารถในการตีความ", "khả năng diễn giải"] },
];
