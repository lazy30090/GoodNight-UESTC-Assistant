# 晚安成电打卡脚本

使用 Node.js 和 Chrome DevTools Protocol 自动完成“晚安成电”登录、状态查询和打卡。

## 使用

克隆或下载项目后，只需要安装 Node.js 22+ 和 Google Chrome，不需要 `npm install`，也不需要创建 `config.json`。

在项目目录运行：

```powershell
cd '项目目录'
node .\wandao.mjs --help
node .\wandao.mjs login    # 只验证登录，不打卡
node .\wandao.mjs probe    # 查询今日状态，不提交
node .\wandao.mjs         # 登录并提交打卡
node .\wandao.mjs --force # 已有状态时仍尝试提交
```

运行后会打开 Chrome。第一次使用时，在窗口中输入学号和密码，并完成短信或扫码二次验证。`login` 只验证登录；`probe` 只查询；不带命令时才会提交打卡。

## 配置文件有什么用？

`config.json` 是可选的本地配置文件，项目不会自带它，也不会上传它。没有这个文件时，脚本使用默认设置，账号密码由你在浏览器中输入，基本功能不受影响。

如果希望自动填入账号密码、指定坐标或设置强制提交，可以复制模板：

```powershell
Copy-Item .\config.example.json .\config.json
```

然后编辑 `config.json`：

```json
{
  "studentId": "你的学号",
  "password": "你的统一身份认证密码",
  "headless": false,
  "point": null,
  "force": false
}
```

也可以使用环境变量，避免密码写入文件：

```powershell
$env:WANDAO_ID = '你的学号'
$env:WANDAO_PW = '你的密码'
node .\wandao.mjs
```

## 项目文件

- `wandao.mjs`：主程序，必需
- `config.example.json`：配置模板，可选
- `probe/cas_probe.mjs`：认证连通性探针，可选
- `README.md`：使用说明

## 注意

脚本使用服务端返回的打卡地点坐标，不读取真实 GPS；最终是否成功以服务端返回结果为准。打卡页若提供 `checkinTicket`，脚本会自动加入请求；学校接口或登录流程变化时可能需要调整代码。

脚本中的 User-Agent 只保留通用浏览器和小程序兼容字段。具体机型、系统构建号、CPU 架构和 Mac 设备标识已移除；`Safari`、`AppleWebKit` 等是标准兼容标记，不是个人信息。