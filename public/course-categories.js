// Local rules only. Saved manual choices take precedence over future rule changes.
export const courseCategories = Object.freeze(['AI 与大模型','数据分析','办公与自动化','语言与沟通','财税与法务','商业与管理','开发工具','编程开发','设计与创作','科学与通识','生活与兴趣','游戏与兴趣','其他主题']);
export const validCourseCategory = value => typeof value === 'string' && courseCategories.includes(value);
const rules = [
  ['AI 与大模型', /大模型|人工智能|机器学习|深度学习|智能体|提示词|神经网络|transformer|DeepSeek|通义|千问|\b(?:llm|gpt|rag|ai)\b/i],
  ['办公与自动化', /办公自动化|办公软件|文字处理|文档排版|演示文稿|机器人流程自动化|\b(?:word|powerpoint|outlook|uipath|rpa|vba|office|wps|ppt)\b/i],
  ['数据分析', /数据分析|数据可视化|数据库|数据处理|商业智能|统计|报表|\b(?:power\s*(?:bi|query)|dax|excel|sql|tableau|bi)\b/i],
  ['开发工具', /版本控制|代码管理|容器|运维|\b(?:git|github|docker|linux|kubernetes|ci\/cd)\b/i],
  ['编程开发', /编程|程序设计|代码|软件开发|前端|后端|自动化脚本|计算机网络|\b(?:python|javascript|typescript|java|rust|c\+\+)\b/i],
  ['语言与沟通', /英语|英文|日语|日文|法语|法文|德语|德文|西班牙语|外语|语言学习|口语|听力|语法|发音|写作|演讲|沟通|会议表达|\b(?:english|japanese|ielts|toefl)\b/i],
  ['游戏与兴趣', /游戏|电竞|三角洲行动|鸣潮|原神|魔兽|\b(?:gaming|esports)\b/i],
  ['财税与法务', /财务|财税|税务|税法|纳税|增值税|发票|会计|记账|合规|法务|法律|法规|合同|合约|公司法|内控|审计|报税|\b(?:vat|ifrs|gaap)\b/i],
  ['商业与管理', /商业|经营|企业管理|公司管理|公司间|管理会计|营销|项目管理|产品经理|运营|创业|供应链|人力资源|绩效|预算|成本|定价|转移价格|价格转移|报价|交付转让|\b(?:mtp|ico|mba|erp|sap)\b/i],
  ['设计与创作', /设计|绘画|摄影|剪辑|视频|音乐|创作|动画|视觉|\b(?:figma|photoshop|illustrator|blender)\b/i],
  ['科学与通识', /数学|物理|化学|生物|历史|地理|哲学|心理学|科学|经济学|逻辑学/i],
  ['生活与兴趣', /健康|健身|烹饪|旅行|生活|兴趣|园艺|运动|理财|个人预算/i],
  ['商业与管理', /管理|金融|投资|证券|基金/i]
];
export function automaticCourseCategory(course={}) {
  const normalize=value=>String(value||'').normalize('NFKC');
  const lessons=Array.isArray(course.lessons)?course.lessons:[];
  // A chapter mentioning a tool must not override the course's own subject.
  const fields=[course.title||course.courseTitle,course.goal,course.description,
    lessons.map(l=>l.title).join(' '),lessons.map(l=>l.objective).join(' '),lessons.flatMap(l=>l.tags||[]).join(' ')];
  for(const field of fields) {
    const source=normalize(field);
    const match=rules.find(([,pattern])=>pattern.test(source));
    if(match) return match[0];
  }
  return '其他主题';
}
export function categoryFor(course={}) {
  return validCourseCategory(course.category)?course.category:automaticCourseCategory(course);
}
const domains=Object.freeze({
  'AI 与大模型':'人工智能','数据分析':'数据与分析','办公与自动化':'技术与开发','语言与沟通':'语言与沟通',
  '财税与法务':'商业与管理','商业与管理':'商业与管理','开发工具':'技术与开发','编程开发':'技术与开发',
  '设计与创作':'设计与创作','科学与通识':'科学与通识','生活与兴趣':'生活与兴趣','游戏与兴趣':'生活与兴趣','其他主题':'待归类'
});
export const courseDomain = course => domains[categoryFor(course)];
export function validCategoryChanges(changes) {
  return Array.isArray(changes) && changes.length<=1000 && new Set(changes.map(c=>c?.id)).size===changes.length
    && changes.every(c=>c && typeof c.id==='string' && /^[a-zA-Z0-9_-]{1,160}$/.test(c.id) && (c.category===''||validCourseCategory(c.category)));
}
