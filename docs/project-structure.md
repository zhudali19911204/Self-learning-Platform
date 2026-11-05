# 项目目录

根目录保留项目配置、说明和轻量启动入口；后端业务模块按职责位于`src/`。

```text
server.mjs               兼容启动入口，转到 src/server.mjs
src/
  server.mjs             HTTP 路由、静态资源与请求校验
  courses/               课程、大纲、资料检索、引用、事实核查、评分
  models/                文字、图片和语音模型适配
  media/                 网页图片与 Commons 图片来源
  runtime/               生成上下文、取消与运行控制
public/                  前端页面及浏览器共享的数据契约
desktop/                 Electron、IPC、存储与资源管理
test/                    自动测试
test-support/            测试样本和显式诊断工具
docs/                    功能与设计说明
```

根目录的`server.mjs`保留原有导出与直接启动能力。`npm start`、`npm run dev`、`npm run desktop`和`npm run desktop:dev`均保持原命令；桌面端内部直接使用`src/`模块。

服务端按文件位置定位根目录的`public/`静态资源，不依赖启动工作目录。构建清单包含`src/**`、桌面端、前端与兼容入口，迁移后的测试及诊断工具也使用新导入路径。

目录整理不移动用户数据：测试版仍使用`.desktop-dev/data/`，正式版仍使用应用原数据目录。`release/`中的已有安装包保持原样；源码变更需要重新构建才会进入新安装包。`.desktop-test/`仅用于隔离验证。
