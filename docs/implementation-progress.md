> Исторический отчёт облачной ветки до объединения с актуальным main. Текущие изменения и результаты проверок: [current-design-integration.md](current-design-integration.md).

# Прогресс Freedom Quality

Ветка codex/business-completion. Работа НЕ полностью завершена; см. requirements-matrix.md и acceptance-audit.md. Main/production не изменялись, live AI запрещён и не выполнялся.

## Реализовано
- Репозиторный воспроизводимый setup.
- Четыре роли и безопасная migration legacy accounts без удаления истории.
- Контроль опубликованной истории и групп; атомарные workflow/уведомления, concurrent appeals, сериализация планирования/retry, уникальные индексы.
- Полный цикл задач развития, история попыток и UI.
- Dataverse pull adapter, mappings, normalization, dedup/retry/log, admin UI, authenticated external-context resolver.
- Корректная историческая аналитика/калибровка, фильтр периода, реальные причины/ожидание очереди.
- Исправлены missing timestamp, неподтверждённый срок апелляции, inverse binary loss и создание AI-клиента при полностью переиспользуемых ответах.

## Проверки
8 unit/contract + 9 isolated PostgreSQL integration tests прошли.
Browser: 24 маршрута, четыре роли, публикация, апелляция, задачи с reload, network error, admin session revocation; mobile render и отсутствие pageerror.
Чистая копия текущего кода: установка, новый PG/venv, seed, pip check, smoke, unit/contract suite прошли на той же Debian 13.
Команды и ограничения — cloud-setup.md. Все тесты используют изолированную БД; рабочие данные не менять.

## Следующие локальные шаги (без повторного аудита)
1. P0: заменить текстовую связь dialogs.operator на стабильный operator_id и убрать угадывание сотрудника из текста в обычном upload. Продумать migration существующих данных и явный выбор/mapping сотрудника в UI; не раздавать данные однофамильцев.
2. P1: тесты возврата задачи и повторного выполнения; аварийного восстановления очереди/синхронизации. Состояние running после падения sync требует отдельного восстановления.
3. P1: durable incremental cursor для Dataverse (текущий pull ограничен 100 страницами), тесты продолжения после сетевого отказа.
4. Когортная метрика повторных ошибок/до-после — только после определения правил выборки, без обещания причинного эффекта.
5. Повторить финальный аудит после этих изменений.

## Внешние блокеры
- Нет первичных PDF ТЗ и demo_design.md. Правила автопубликации/порогов унаследованы, не объявлять согласованными.
- Нет Dynamics tenant/schema/app registration/секретов. Реальный web resource, SSO/cross-site iframe и обратная отправка требуют контракта и доступа; см. dynamics.md.
- GitHub API Forbidden: PR не создан. Git push работает; коммиты сохраняются в ветке. Не запрашивать Git token только из-за gh auth status.
- Платформенный config draft остаётся неподтверждённым INVALID_ARGUMENT, есть репозиторный fallback.

Продолжать с пункта 1. Merge/deploy не разрешены.
