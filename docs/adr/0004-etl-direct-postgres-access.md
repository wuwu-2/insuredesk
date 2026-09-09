# ADR 0004: 数据湖 ETL 直连生产 PostgreSQL(开放 5432)

状态:已接受(2026-09-10)

## 背景

运维需要将业务数据落到 data lake,明确要求的形态是**直连生产 PostgreSQL**:
ETL 作业从内网经 TCP 连 5432,用 SQL 抽取。应用层 API(/api/v1 增量流)
经讨论后排除,不走应用出口。

## 决策

- **发布端口**:db 容器发布 `0.0.0.0:5432:5432`。源限制由**云厂商安全组**
  承担(Docker 走自己的 iptables 链,ufw/firewalld 拦不到发布端口,
  安全组在宿主机网络栈之外生效,是唯一可靠的那层)。pg_hba 不写源地址段,
  全源 scram-sha-256。
- **专用只读角色 etl_ro**:LOGIN,NOSUPERUSER/NOCREATEDB/NOCREATEROLE/
  NOREPLICATION;SELECT 白名单 = 工单域表(tickets、ticket_*_details、
  process_logs、ticket_import_batches、sla_policies、ticket_kinds、
  五个字典目录表)。排除:users/roles/sessions/api_keys/api_access_logs/
  api_key_audit_logs(认证与审计面)、app_notifications、
  callback_deliveries、shift_types/schedules。
- **未来表自动授权**:`ALTER DEFAULT PRIVILEGES FOR ROLE insuredesk`
  让迁移角色新建的表自动对 etl_ro 开放 SELECT,避免「发版后 ETL 静默
  断表」。已知代价:**未来新增的敏感表会被自动暴露**,新增敏感表时须显式
  REVOKE。
- **口令不落仓库**:migration 只建角色;bootstrap 每次启动从
  `ETL_RO_PASSWORD`(.env)幂等 `ALTER ROLE`。轮换 = 改 .env +
  `up -d` recreate。留空则角色无口令、无法认证,直连保持关闭。
- **内网明文**:ETL 链路限定内网,不配 PG SSL,pg_hba 用 `host` 而非
  `hostssl`。前提:该内网段不被外部路由可达。
- **PII 原始值出域**:不脱敏、不建掩码视图,业务方已确认。

## 明确拒绝的防护(决策方已知悉并接受)

- 角色级 `statement_timeout` / 连接数上限:ETL 失控查询拖垮单实例生产库
  的风险**未缓解**,由 ETL 侧自律。
- `log_connections`:无连接审计,无法事后追溯「谁在什么时候连过库」。
- 口令轮换演练与主动告警。

## 后果

- 攻击面:5432 常开,唯一纵深是云安全组 + scram 口令;安全组误配 =
  含 PII 与用户口令哈希的库面对全源爆破(etl_ro 之外的角色口令同受此面)。
- schema 漂移:ETL 把 Prisma schema 当隐式契约,迁移改表会无声打碎
  抽取作业;无兼容承诺。
- 急停:删 compose 的 `ports:` 行 + `up -d`,30 秒内关闭,库本身不动。
- 巡检:`docker compose ps` + `docker logs insuredesk-db-prod`。
