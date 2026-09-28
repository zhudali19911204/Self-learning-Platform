export const questionnaire = {
  summary: '你希望用 Python 减少工作中的重复操作，具体成果还需要确认。',
  questions: [
    { id: 'q1', question: '你最想先解决哪类重复工作？', why: '应用场景决定案例与学习顺序。', type: 'single', options: [
      { id: 'o1', label: '整理文件', description: '按规则分类和重命名文件。' },
      { id: 'o2', label: '处理报表', description: '整理和核对表格数据。' }
    ] },
    { id: 'q2', question: '你希望怎样检验学习成果？', why: '用成果判断是否真正学会。', type: 'multiple', options: [
      { id: 'o1', label: '完成一个可用的小工具', description: '可以独立解决自己的问题。' },
      { id: 'o2', label: '解释每一步的原因', description: '能够定位常见错误。' }
    ] }
  ]
};
export const clarification = {
  questionnaire,
  answers: [
    { questionId: 'q1', optionIds: ['o1'], detail: '在 Windows 上整理本地文件，先学预览再执行。' },
    { questionId: 'q2', optionIds: ['o1','o2'], detail: '' }
  ],
  notes: '不学习网页开发。'
};
