# Облачная разработка Freedom Quality

Поддерживаемая среда: Debian 13 amd64, обычный пользователь, Python 3.12 с venv, bash, apt-get, dpkg-deb и системный Debian archive keyring. Нужен HTTPS к pypi.org, files.pythonhosted.org и deb.debian.org. TLS и подписи APT проверяются.

Используйте существующий checkout изолированной задачи; создавать worktree не требуется.

```bash
cd /workspace/Data-Challenge
bash scripts/cloud-install.sh
bash scripts/cloud-start.sh
```

Сервер работает в foreground. В другом терминале:

```bash
cd /workspace/Data-Challenge
.venv/bin/python scripts/cloud-check.py
```

Установка хранит Python и PostgreSQL в игнорируемой .venv, данные — в .pgdata. Создаётся отсутствующий .env без ключей (его требует приложение). Существующий .env сохраняется. Старт использует локальную базу cqa и переопределяет DATABASE_URL только для процесса. Повторное заполнение не сбрасывает базу. Порты можно задать CQA_DB_PORT и CQA_HTTP_PORT; HTTP-порт передайте также проверке.

Это локальная демосреда: PostgreSQL trust-auth и HTTP привязаны к 127.0.0.1. Для остановки HTTP нажмите Ctrl-C; PostgreSQL:
```bash
LD_LIBRARY_PATH="$PWD/.venv/cloud/pg/usr/lib/x86_64-linux-gnu" .venv/cloud/pg/usr/lib/postgresql/17/bin/pg_ctl -D "$PWD/.pgdata" -m fast -w stop
```

API-ключ не требуется для импортированных оценок. Новые оценки требуют настоящего ANTHROPIC_API_KEY через настройки секретов среды и доступа к api.anthropic.com; ключи в Git не добавлять. Доступность заданных приложением моделей не проверена.

## Проверка воспроизводимости
Проверено на отдельной копии git archive HEAD с добавленными cloud-скриптами, без прежних .venv, .env и .pgdata. Зависимости скачаны заново; создан отдельный кластер PostgreSQL на 55433, HTTP на 18000. Успешны pip check и функциональная проверка HTML, OpenAPI, входа QA, списка диалогов, импортированной оценки, очереди и выхода. Это чистое состояние проекта на той же ОС, не новая облачная машина. Прямые Python-зависимости фиксированы requirements.txt; транзитивные и Debian-пакеты могут обновляться.

## Диагностика платформы
Исходный запрос имел форму config с двумя строковыми полями install_script и start_skill, что соответствует схеме инструмента. Чтение черновика без параметров ранее также возвращало INVALID_ARGUMENT. Новый сокращённый запрос с командами вызова репозиторных скриптов вернул тот же код и сообщение: “Setup could not be completed; saving the draft could not be confirmed.” Идентификатор черновика и сведения об ошибочном поле не возвращены. Точная серверная причина неизвестна; сохранение и публикация не подтверждены.

Для будущих задач сначала включите эти файлы в доступный им commit репозитория. Затем выполните команды выше. При восстановлении платформенного сохранения install_script может содержать bash /workspace/Data-Challenge/scripts/cloud-install.sh; start_skill — запуск cloud-start.sh и cloud-check.py. Живые процессы между задачами не сохраняются.

## Проверки бизнес-сценариев
После установки:
- .venv/bin/python -m unittest discover -s tests -v
- PYTHONPATH=. .venv/bin/python tests/integration.py
- PYTHONPATH=. .venv/bin/python tests/browser_server.py (отдельный процесс)
- node tests/browser.cjs (нужны Playwright и Chromium; CHROMIUM_PATH при другом расположении)

Integration и browser_server создают собственную случайно именованную БД на локальном PostgreSQL и удаляют её при штатном завершении. TEST_PG_ADMIN задаёт административное подключение тестового кластера, TEST_HTTP_PORT — порт browser server, TEST_BASE_URL — URL браузерного теста. Не направлять browser.cjs на рабочий экземпляр: тест выполняет действия четырёх ролей. Реальные AI-клиенты в тестовом сервере заблокированы.

Схема обновляется при запуске. Legacy head/comp → qa, dir → lead с отключением этих учётных записей до проверки администратором. Пользователи и история не удаляются. Перед обновлением существующей рабочей БД нужна её резервная копия. Уникальные индексы текущей оценки/открытой апелляции намеренно остановят миграцию при старых дубликатах; их нельзя автоматически удалить без проверки бизнес-истории.

Playwright закреплён в tests/package-lock.json. Для браузерных проверок установите npm ci --prefix tests (при недоступном домашнем cache добавьте --cache /tmp/cqa-npm-cache). Chromium должен быть установлен в образе; при его отсутствии используйте npx --prefix tests playwright install chromium и задайте CHROMIUM_PATH к установленному бинарному файлу.
