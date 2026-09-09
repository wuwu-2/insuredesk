BEGIN;

-- ETL 数据湖直连的只读角色（ADR 0004）。
-- 幂等:角色是 cluster 全局对象,migrate dev 的影子库会先建一次,主库重放
-- 时裸 CREATE ROLE 必报 already exists。
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'etl_ro') THEN
    CREATE ROLE etl_ro LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
  END IF;
END $$;

-- CONNECT 走 PUBLIC 默认授权,不显式 GRANT(避免 db 名硬编码)。
GRANT USAGE ON SCHEMA public TO etl_ro;

-- 工单域白名单。排除 users/roles/sessions/api_keys/api_access_logs/
-- api_key_audit_logs（认证与审计面）、app_notifications（内部通知）、
-- callback_deliveries（内部投递 ops）、shift_types/schedules（排班）。
GRANT SELECT ON
  tickets, ticket_complaint_details, ticket_refund_details, process_logs,
  ticket_import_batches, sla_policies, ticket_kinds, ticket_categories,
  channels, completion_statuses, user_feedback_channels, feedback_receive_channels
TO etl_ro;

-- 迁移角色日后新建的表自动对 etl_ro 开放 SELECT —— 不发版即断表，代价是
-- 未来新增的敏感表会被自动暴露（ADR 0004 已记录的取舍）。
-- FOR ROLE 缺省 = 当前角色：migrate 的执行角色就是日后建表的角色；
-- 硬编码 insuredesk 会在 testcontainers（执行角色不同）里直接炸。
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT ON TABLES TO etl_ro;

COMMIT;
