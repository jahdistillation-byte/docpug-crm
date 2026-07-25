# PUGCRM Stage 0.1: security handoff

Эта инструкция не разрешает применение migration, deploy или ротацию из Codex.
Все production-действия выполняются отдельно после review, backup и явного
разрешения владельца.

## Что подготовлено

- Supabase CLI закреплена на версии `2.109.1`.
- Migration: `supabase/migrations/20260721081533_stage_0_1_database_security_baseline.sql`.
- Контракт доступа: `supabase/tests/database/stage_0_1_security_baseline.sql`.
- Изолированный ACL-fixture: `supabase/tests/fixtures/stage_0_1_legacy_schema.sql`.
- Локальный `.env` игнорируется Git; пример переменных находится в
  `.env.example`.

Migration рассчитана на текущую архитектуру: браузер работает только через
Flask, а Flask обращается к Supabase с server-only secret key. Поэтому
`anon`/`authenticated` не получают прямого доступа к business tables и RPC.

## Проверка до production

1. Запустить Docker Desktop и убедиться, что `docker info` проходит.
2. Получить отдельный проверенный schema-only snapshot production через
   `supabase db dump` после предоставления CLI access token и database password.
   Не включать данные и секреты; не считать текущую пустую историю migrations
   схемой.
3. Оформить snapshot как baseline, который применяется раньше security
   migration. Перед production baseline помечается уже применённым: существующие
   таблицы нельзя создавать повторно. Точный migration-order и repair-команда
   проходят отдельный review.
4. Поднять локальный Supabase закреплённой CLI:

   ```bash
   npx --yes supabase@2.109.1 start
   ```

5. На чистой локальной базе применить baseline, затем migration Stage 0.1.
   Migration содержит preflight и намеренно откажется выполняться на пустой или
   drifted-схеме.
6. Выполнить pgTAP-контракт:

   ```bash
   npx --yes supabase@2.109.1 test db --local \
     supabase/tests/database/stage_0_1_security_baseline.sql
   ```

7. Выполнить backend tests и smoke-проверки login/session, визитов, оплат,
   расходов, поставщиков, создания закупки и partial/full receive.
8. Сохранить перед применением backup и отдельные snapshots `pg_policies`, ACL,
   function definitions/signatures и production schema. Сравнить их с теми,
   против которых migration прошла локально.

Если schema snapshot не содержит все 29 ожидаемых business tables и восемь
аудированных функций, pgTAP должен завершиться ошибкой. Нельзя исключать эту
проверку ради зелёного результата.

Для проверки самой ACL-логики без production-данных предусмотрен test-only
fixture. Он создаёт только минимальные таблицы, sequences, policy и сигнатуры RPC
в локальном Supabase, после чего migration и 26 pgTAP-инвариантов должны пройти.
Fixture не содержит настоящих колонок, constraints или function bodies и не
заменяет production-equivalent baseline/E2E. Его запрещено применять к hosted
project.

## Ротация скомпрометированного service-role ключа

1. В Supabase Dashboard открыть **Settings → API Keys → Publishable and secret
   API keys** и создать отдельный named secret key (`sb_secret_...`) для Flask.
   Старый legacy `service_role` пока оставить активным.
2. В secret store хостинга заменить значение `SUPABASE_SERVICE_KEY` на новый
   secret key. Не добавлять ключ в Git, build args, frontend, логи или SQL.
3. Перезапустить только backend и проверить health/login, чтение данных, оплату
   визита и закупочную RPC. Убедиться, что browser bundle не содержит ключа.
4. Проверить остальные места использования legacy key: CI/CD, cron/workers,
   webhooks, интеграции и локальные production-профили.
5. Только после успешного smoke test деактивировать legacy `service_role` в
   Dashboard. Деактивация обратима; удаление/полная ротация JWT secret — отдельная
   операция и не должна смешиваться с этим hotfix.
6. Проверить логи на `401/403`, повторить smoke/E2E и зафиксировать время,
   исполнителя и идентификатор нового ключа без сохранения самого значения.

Новый secret key, как и legacy `service_role`, обходит RLS. Он допустим только на
контролируемом backend. Публичный bucket `patient-files` нельзя использовать для
финансовых документов; private finance bucket появится в Stage 1.1.

## Production migration

После отдельного разрешения: backup → schema/ACL diff → проверенная migration →
SQL invariants/advisors → backend deploy → frontend deploy → smoke/E2E. При
ошибке откат выполняется отдельной reviewed migration по сохранённым ACL/policy
snapshots, а не ручными несогласованными командами.
