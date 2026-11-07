# Dynamics 365 / Dataverse

Реализован pull-адаптер Dataverse Web API v9.2, не заменяющий CRM. Новые диалоги импортируются без AI-вызовов. Администратор запускает синхронизацию в разделе Dynamics 365, видит завершение, количество импортов/повторов и ошибки. Повтор запуска безопасен; изменённый внешний диалог не перезаписывает историю, а требует сверки.

## Конфигурация
- DYNAMICS_URL: HTTPS origin tenant, например https://organization.crm.dynamics.com.
- DYNAMICS_ENTITY: реальное имя entity set, доступного application user.
- DYNAMICS_ACCESS_TOKEN: bearer token с Read на нужные таблицы; только через секреты среды. Обновление токена выполняет инфраструктура Entra ID, адаптер не хранит refresh token.
- DYNAMICS_FIELDS: JSON object с ключами id, operator, team, transcript, occurred_at, channel, language. Значения — фактические logical names Dataverse. Схема заказчика в репозитории отсутствует, поэтому фиктивных значений по умолчанию нет.
- DYNAMICS_OPERATORS: JSON mapping внешнего employee ID → существующий login оператора.
- DYNAMICS_TEAMS: JSON mapping внешнего team ID → существующее имя группы.

Контракт после mapping: id UUID; transcript — JSON-массив реплик или строка с таким JSON, speaker client/operator/bot/system, непустой text; channel agent chat/voice call; language RU/KZ/EN; occurred_at ISO 8601 с timezone. Сотрудник активен, role=op, группа совпадает. Внешние ID сохраняются отдельно. Ключ дедупликации — tenant/entity/id. Нормализация обрезает пробелы текста, не меняя содержание.

Настройте разрешение исходящего HTTPS только к tenant; разрешения токена также ограничьте tenant. Redirects запрещены; nextLink допускается только в том же API origin/path. Retry для 429/502/503/504 ограничен тремя попытками; далее сохранённый журнал позволяет повторить импорт вручную. Pagination ограничена 100 страницами; для больших объёмов нужна согласованная incremental view/cursor (ещё не реализована). Частично импортированные страницы сохраняются; повтор не дублирует их.

## Встраивание
Минимальный поддерживаемый способ: iframe/web resource Dynamics с URL приложения и #/dialog/<internal_id>. Deep link сохраняется после входа; API повторно проверяет права. Internal ID можно получить из external_dialogs по source/external_id на сервере интеграции; параметры URL не дают дополнительных прав.

Для cookie-auth разместите приложение через same-site HTTPS reverse proxy с Dynamics. Текущий cookie SameSite=Lax не поддерживает произвольный cross-site iframe. Cross-site вариант требует Entra SSO/BFF и CSRF-защиты; не ослабляйте cookie ради iframe. Проверка настоящего web resource и Entra flow заблокирована отсутствием tenant/registration. Demo-login предназначен только для изолированной демосреды; при реальном подключении DEMO_LOGIN=0.

Обратная отправка оценок не подтверждена первоисточником ТЗ и не реализована. Нужны схема целевой сущности, правила версий и разрешение Write, если заказчик подтвердит этот обмен.

## Проверки и недостающие доступы
Контрактные тесты используют httpx MockTransport: retry, mapping, запрет ухода nextLink на другой origin, отказ авторизации. DB-тест проверяет импорт, повтор и конфликт изменённого текста.
Реальное подключение не проверено. Нужны tenant, app registration/application user, тестовые сущности и реальные logical names, сопоставления сотрудников/групп, безопасно переданный токен, разрешённый домен. API-ключи и токены в Git не добавлять.

Контекст внешнего диалога: web resource может открывать приложение с ?dynamics_id=<UUID>. После аутентификации UI вызывает GET /api/integrations/dynamics/dialog/{external_id}, разрешает source по DYNAMICS_URL/DYNAMICS_ENTITY и переходит к внутреннему диалогу. Endpoint проверяет те же права, включая запрет оператору на неопубликованные оценки. Неизвестный или чужой ID не даёт доступа.
