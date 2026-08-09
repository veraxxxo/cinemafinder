@echo off
chcp 65001 >nul
rem ============================================================================
rem  Сбор данных карты с этой машины.
rem
rem  Зачем: сайты афиш отбивают адреса дата-центров, где работают облачные
rem  раннеры GitHub. С домашнего адреса они открыты, и данных получается
rem  заметно больше. Скрипт делает всё сам: обновляет код, ставит зависимости,
rem  собирает и отправляет результат в репозиторий.
rem
rem  Запуск: двойной клик по файлу.
rem ============================================================================

setlocal
cd /d "%~dp0"

rem Портативный Node из OmniHub, если системного нет в PATH.
where node >nul 2>nul
if errorlevel 1 (
  if exist "%LOCALAPPDATA%\nodejs\node.exe" (
    set "PATH=%LOCALAPPDATA%\nodejs;%PATH%"
  ) else (
    echo.
    echo   Node.js не найден. Поставь его с https://nodejs.org (LTS^) и запусти снова.
    echo.
    pause
    exit /b 1
  )
)

where git >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Git не найден. Поставь с https://git-scm.com/download/win и запусти снова.
  echo.
  pause
  exit /b 1
)

echo.
echo === Обновляю код ===
git pull --rebase --autostash || goto :fail

echo.
echo === Зависимости ===
call npm install --no-audit --no-fund || goto :fail

rem Настоящий браузер: им берётся киноафиша, обычный запрос она отбивает.
call npx playwright install chromium

echo.
echo === Собираю данные ===
rem С домашнего адреса ограничения не нужны: берём больше дат и фильмов.
set DAYS=5
set KA_MOVIE_LIMIT=80
set KM_MOVIE_LIMIT=60
set EVENT_DAYS=14
call npm run update || goto :fail

echo.
echo === Отправляю в репозиторий ===
git add data/
git diff --cached --quiet && (
  echo   Изменений нет — данные и так свежие.
) || (
  git commit -m "data: сбор с домашней машины" || goto :fail
  git push || goto :fail
  echo   Готово. Карта обновится через минуту-две.
)

echo.
echo Всё прошло успешно.
pause
exit /b 0

:fail
echo.
echo   Что-то пошло не так — смотри сообщение выше.
pause
exit /b 1
