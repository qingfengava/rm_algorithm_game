# 网站注册和管理员审核

注册字段为实名、学号、QQ 号和密码。注册申请先保存到 `registration_requests`，只有管理员审核通过后才会创建正式 `users` 记录。

## 用户流程

```text
注册 -> PENDING_REVIEW -> 管理员审核 -> APPROVED -> 学号登录
                                      `-> REJECTED
```

实名是排行榜、比赛列表和比赛详情中的公开显示名；学号是登录账号；QQ 号只用于管理员联系，不在公共页面显示。申请状态查询令牌只在注册响应中返回，数据库保存的是令牌哈希。

## API

```text
POST /register
GET  /register/status/{id}?token=...
POST /login                         { student_no, password }
GET  /admin/registrations
POST /admin/registrations/{id}/approve
POST /admin/registrations/{id}/reject { reason? }
```

审核通过操作在一个数据库事务中完成：锁定申请、再次检查学号、创建普通选手账户并更新申请状态。重复审核会返回冲突，待审核申请不会提前创建可登录账户。

密码使用现有 scrypt 哈希存储，系统不会保存明文密码。没有邮箱字段时，忘记密码由管理员人工核验学号和 QQ 后重置。

