# eng-delivery · 前端（事实底座工作台）

工程交付大脑的轻量前端：**只做展示与调用**，所有解析 / 检索 / 推理 / 组卷都在后端 agent。
一条主线串起「事实底座」全流程：

1. **项目** —— 新建项目、查看列表与状态流转
2. **文档录入** —— 粘贴合同 / 招标 / 规范文本，后端切块带页码并向量化入库
3. **语义检索** —— 带引用的检索，命中片段溯源到页码 / 条款，标注引擎（大模型 / 离线兜底）
4. **变更 → 索赔** —— 登记现场变更，一键触发长流程（范围认定 → 归集依据 → 影响量化 → 起草正文 → 组卷连边），
   抽屉里看每步审计；中途断电 / 超时可**从断点续跑**（已完成步骤不重跑、不重复出卷）
5. **事实图谱** —— 看索赔挂回哪条变更、引用了哪条合同原文（关联图谱边）

## 技术栈

- React + Vite + TypeScript
- Tailwind CSS + shadcn/ui 风格基础组件（Button / Card / Input / Badge …）
- Ant Design 负责富数据组件（Table / Steps / Timeline / Drawer / Select / message …）
- 设计取向参考 taste skill 的 `minimalist-ui`：暖色单色、极细灰边框、低圆角、颜色作为稀缺语义资源

## 开发

```bash
# 先在 ../（eng-delivery 后端）跑 npm run dev，监听 3002
npm install
npm run dev        # http://localhost:5173，/api 自动代理到 http://localhost:3002
```

自定义后端地址：`API_TARGET=http://host:port npm run dev`。

## 构建 / 检查

```bash
npm run build      # tsc -b + vite build
npm run typecheck
```
