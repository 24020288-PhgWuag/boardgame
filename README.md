# OTT V2 Multiplayer Game

Game co-op 2 người trên bàn 9x9. Người chơi di chuyển quân theo 8 hướng; khi đi vào ô có quân đối phương, luật kéo-búa-bao quyết định bên thắng.

## Chạy local

```bash
npm install
npm start
```

Mở `http://localhost:3000` trong hai tab trình duyệt. Một người tạo phòng, người còn lại nhập mã phòng.

### Tài khoản người chơi

Để tạo hoặc tham gia phòng online, hãy đăng ký/đăng nhập bằng nút **Đăng nhập** ở góc trên sảnh.
Tên tài khoản sẽ được hiển thị trên thẻ người chơi trong trận. Mật khẩu được băm bằng `scrypt`;
thông tin tài khoản được lưu tại `data/users.json` (không lưu mật khẩu dạng rõ). Chế độ chơi
với Bot và Pass & Play vẫn có thể bắt đầu mà không cần đăng nhập. Mỗi tài khoản bắt đầu ở
100 ELO; sau mỗi trận online giữa hai tài khoản, người thắng nhận ELO và người thua bị trừ
theo chênh lệch xếp hạng. Bảng xếp hạng có thể xem ngay tại sảnh.

Khi tạo phòng online, trường **Mật khẩu phòng** có thể để trống để tạo phòng công khai hoặc
điền mật khẩu để giới hạn người tham gia. Các phòng đang chờ sẽ tự động xuất hiện trong danh
sách **Phòng đang chờ người** của những người chơi khác; phòng có mật khẩu được đánh dấu 🔒.

Chọn **Đấu với Bot (AI)** để tạo một phòng do server quản lý với bot Python ở phía P2.
Bot mặc định chạy từ `bots/random_bot.py` qua JSON Lines trên stdin/stdout.

Chọn **Bot đấu Bot** để mở một phòng spectator trên frontend. Trước khi bắt đầu,
chọn bot cho P1/P2 (**Minimax** hoặc **Random**) và tốc độ (**Chậm**, **Vừa**,
**Nhanh**). Trình duyệt nhận các state update theo thời gian thực. Nút
**Chơi lại** bắt đầu lại trận bot-vs-bot hiện tại với cùng cấu hình. Hộp thoại
kết quả có thể đóng bằng nút **Đóng kết quả**.

Trong khi trận đấu đang chạy, dùng bộ chọn tốc độ trên thanh lượt để đổi
**Chậm**, **Vừa** hoặc **Nhanh** ngay lập tức. Tên bot được hiển thị trên thẻ
của P1/P2.

Trong hộp thoại Bot đấu Bot, chọn file Python của bạn (`.py`, tối đa 256 KB)
và nhấn **Tải bot lên**. Bot sẽ xuất hiện trong danh sách P1/P2 và được chạy
bằng Docker cách ly (cần Docker Engine) và cùng giao thức JSON Lines như các bot
có sẵn. Bot phải đọc một JSON object
trên mỗi dòng từ `stdin`, trả về một JSON object trên mỗi dòng ở `stdout`, và
ghi log chẩn đoán vào `stderr`.

### Bảo vệ khi chạy bot không đáng tin

Bot tải lên và bot đăng ký giải cộng đồng không được chạy trực tiếp bằng Python
trên host. Tạo image runner một lần:

```powershell
docker build -f .\docker\bot-runner.Dockerfile -t boardgame-python-bot:latest .\docker
```

Có thể đổi tên image bằng `BOT_DOCKER_IMAGE` hoặc executable Docker bằng
`DOCKER_BIN`. Runner dùng `--network none`, filesystem chỉ đọc, mount chỉ file
bot ở chế độ read-only, user không đặc quyền, bỏ toàn bộ Linux capabilities,
`no-new-privileges`, giới hạn 128 MiB RAM / 0.5 CPU / 32 process, giới hạn
file descriptor và kích thước file, cùng `/tmp` 16 MiB `noexec`. Python chạy
ở chế độ isolated (`-I -S`). Mỗi lượt có timeout 5 giây mặc định; timeout,
JSON sai hoặc output vượt 64 KiB sẽ dừng tiến trình/container. Đổi executable,
image và timeout bằng cấu hình của `BotProcess` nếu cần.
Trận headless có thời hạn tối đa 30 phút mặc định (`BOT_MATCH_TIMEOUT_MS`);
khi hết giờ, các bot bị dừng và trận được tính hòa.

Các giới hạn container giảm đáng kể phạm vi ảnh hưởng nhưng không phải ranh
giới bảo mật tuyệt đối: bot vẫn chạy mã native qua runtime, và container dùng
chung kernel host. Với dịch vụ công khai, chạy Docker trên worker/VM riêng,
không mount socket Docker hay dữ liệu host, luôn vá kernel/runtime và ưu tiên
runtime có cách ly kernel như gVisor/Kata Containers. Pin image theo digest đã
kiểm tra trong production. Tiếp tục áp dụng quota upload, xác thực/giới hạn tốc
độ API, hàng đợi có giới hạn concurrency, giám sát và xóa container sau trận.

Mỗi trận bot-vs-bot hoàn tất cũng được tự động lưu thành replay trong thư mục
`matches/`. Tên file có dạng
`bot-p1-bot-p2-yyyymmdd-hhmmss.json`, ví dụ
`minimax-bot-random-bot-20261015-163500.json`, và có thể xem tại
`http://localhost:3000/replay.html`.

Từ sảnh chính, nhấn **🎬 Xem replay** để mở trình xem replay trực quan.

Có thể thay Python executable hoặc bot bằng biến môi trường:

```powershell
$env:PYTHON_BIN = "python"
$env:BOT_SCRIPT = "bots/random_bot.py"
npm start
```

### Hồ sơ, ELO và tìm trận

Tài khoản có hồ sơ với hạng Đồng/Bạc/Vàng/Kim cương, lịch sử 30 trận gần nhất
và thay đổi ELO sau từng trận. Nút **Tìm trận nhanh theo ELO** ghép người chơi
đang chờ với đối thủ chênh lệch tối đa 250 ELO. Mỗi lượt online có 30 giây;
server là nguồn thời gian chính và xử thắng khi hết giờ.

Dữ liệu tài khoản và lịch sử trận được lưu trong `data/boardgame.sqlite`.
Server tự migrate dữ liệu cũ từ `data/users.json` lần đầu chạy. SQLite dùng
`node:sqlite`, vì vậy cần Node.js 22.5+ (khuyến nghị Node.js 24+).

### Trang quản trị

Mở `http://localhost:3000/admin.html`. API quản trị yêu cầu tài khoản khớp
với biến môi trường `ADMIN_USERNAME`:

```powershell
$env:ADMIN_USERNAME = "quangphuong"
npm start
```

Trang quản trị hiện hiển thị danh sách tài khoản, ELO, hạng và số trận.

Bot chỉ gửi một hành động đã thử. Server vẫn giữ trạng thái thật, kiểm tra luật,
áp dụng nước đi và xác định người thắng.

### Giao thức bot

Server gửi một JSON object mỗi dòng khi đến lượt bot:

```json
{
  "protocol_version": 1,
  "type": "your_turn",
  "player": "p2",
  "ruleset": "classic-v1",
  "state": {
    "board": [],
    "entities": [],
    "terrain": []
  },
  "time_limit_ms": 5000
}
```

Bot trả về một JSON object mỗi dòng:

```json
{
  "protocol_version": 1,
  "type": "action",
  "action": {
    "type": "move",
    "from": { "row": 8, "col": 8 },
    "to": { "row": 7, "col": 7 }
  }
}
```

`stdout` chỉ dành cho giao thức. Log chẩn đoán phải ghi vào `stderr`.

### Cho hai bot đấu với nhau

Chạy một trận headless giữa hai tiến trình Python:

```powershell
npm run bot:match
```

Có thể chọn chế độ và giới hạn số lượt:

```powershell
npm run bot:match -- tactical 500
```

Trận đấu dùng cùng `gameState.js` với server, nên mọi nước đi của bot vẫn
được server game engine kiểm tra và áp dụng. Cả hai bot mặc định chạy
`bots/random_bot.py`; có thể thay bot P1/P2 trong `src/botMatch.js`.

Bot Minimax có thể đấu với bot mặc định:

```powershell
npm run bot:match -- classic 200 bots/minimax_bot.py bots/random_bot.py
```

`bots/guardian_bot.py` là bot phòng thủ chiến thuật: ưu tiên thắng ngay, chặn
nước thắng kế tiếp của đối thủ, tránh tự làm mất quân cuối cùng của một loại,
đánh giá nguy cơ bị phản công và ưu tiên các nước ăn an toàn. Bot vẫn dùng
cùng giao thức JSON Lines và có thể chạy trong giải đấu như các bot khác.

Bot Random chọn ngẫu nhiên có trọng số giữa mọi nước đi hợp lệ, vẫn ưu tiên
nhẹ các nước ăn được quân hoặc tiến về căn cứ nên không lặp lại một đường đi
cố định. Bot Minimax dùng tìm kiếm 3 ply với alpha-beta pruning ở mọi thế cờ,
thay vì tự giảm xuống 2 ply khi có nhiều nước đi.

### Ghi kết quả trận vào Google Sheets

Khi cấu hình bật tính năng này, kết quả trận hoàn tất trong phòng người chơi,
trận người-vs-bot, bot-vs-bot và trận giải đấu sẽ tự đưa vào Redis trước khi
worker ghi batch xuống Google Sheets. API cũng có thể nhận kết quả từ một
producer ngoài:

Trang multiplayer kết nối WebSocket tới cùng host đang phục vụ trang
(`location.host`). Nếu dùng link production, phải deploy code backend mới và
cấu hình credentials, Redis/queue trên chính server production đó; `.env` trên
máy local chỉ áp dụng cho `localhost`. Khi server khởi động, log cho biết chức
năng tự đồng bộ đã bật hay chưa. Khi hoàn tất một trận, log `Completed
multiplayer match ... queued...`, sau đó worker báo `Appended ... to Google
Sheets.` nếu ghi thành công.

```text
POST /api/match-results
Authorization: Bearer <MATCH_INGEST_TOKEN>
Content-Type: application/json
```

Body cho một trận:

```json
{
  "matchId": "match-123",
  "bot1": "alpha",
  "bot2": "beta",
  "winner": "bot1",
  "playedAt": "2026-10-25T15:00:00.000Z"
}
```

`winner` nhận `bot1`, `bot2` hoặc `draw`; `playedAt` có thể bỏ qua. Có thể
gửi tối đa 100 trận trong `{ "results": [...] }`. Endpoint trả HTTP `202` khi
đã nhận vào Redis; phản hồi không có nghĩa là Google Sheets đã ghi xong.
Cùng `matchId` được bỏ qua trong 7 ngày để client có thể retry an toàn. Nếu
hàng đợi đầy hoặc Redis không sẵn sàng, server trả `503` để caller retry có
backoff.

#### Cấu hình xác thực Google

1. Tạo Google Cloud project, bật **Google Sheets API**, rồi tạo Service Account
   và tải JSON key về máy chủ dưới tên ngoài repository.
2. Mở JSON, lấy `client_email`, rồi chia sẻ spreadsheet
   [ID đã cấu hình](https://docs.google.com/spreadsheets/d/1ih-uW88lfBq_e1d0meTgUvZtVWXX455aNl5nxbqNGD4/edit)
   cho email đó với quyền **Editor**. Worker tự tạo tab `Matches` và hàng tiêu
   đề (`matchId`, `bot1`, `bot2`, `winner`, `playedAt`) nếu chưa có.
3. Sao chép `.env.example` thành `.env`, đặt `MATCH_INGEST_TOKEN` thành secret
   ngẫu nhiên mạnh nếu dùng endpoint nhận dữ liệu từ bên ngoài, cập nhật
   `GOOGLE_APPLICATION_CREDENTIALS` thành đường dẫn JSON trên host và cấu hình
   `REDIS_URL`. Chỉ ghi tự động từ các trận trong game không cần token này.
   `.env` và key JSON không được commit hoặc gửi cho client/bot.
4. Chạy Redis có persistence (AOF/RDB), giới hạn truy cập mạng và đặt chính
   sách không eviction cho queue; sau đó `npm start`. Thiếu token thì endpoint
   bị tắt. Mọi server instance phải dùng cùng Redis.

Để thử trên máy đơn chưa cài Redis, đặt `MATCH_RESULTS_QUEUE=memory` trong
`.env`. Worker vẫn tự ghi Sheets, nhưng queue sẽ mất khi server dừng và không
dùng chung được giữa nhiều instance. Chỉ dùng chế độ này để kiểm tra local;
xóa biến hoặc đặt `MATCH_RESULTS_QUEUE=redis` khi chuyển sang triển khai thật.

Worker chỉ cho phép một instance ghi tại một thời điểm qua Redis lock, tối đa
500 hàng mỗi request, flush mỗi 3 giây và cách các lần append tối thiểu 1.2
giây (tối đa khoảng 50 request/phút, thấp hơn quota Sheets phổ biến 60
request/phút). Chỉnh qua các biến `MATCH_SHEETS_BATCH_SIZE`,
`MATCH_SHEETS_FLUSH_INTERVAL_MS`, `MATCH_SHEETS_MIN_APPEND_INTERVAL_MS`,
`MATCH_SHEETS_RANGE` và `MATCH_RESULTS_MAX_QUEUE`. Google Sheets không phù hợp
làm kho dữ liệu thời gian thực cho 10.000 trận/giây: khi queue đầy, API trả
`503`; dùng PostgreSQL/BigQuery làm nguồn dữ liệu chính, rồi xuất báo cáo sang
Sheets theo batch. Redis persistence và backup vẫn cần thiết. Nếu timeout xảy
ra sau khi Google đã append nhưng trước khi worker nhận phản hồi, retry có thể
tạo dòng trùng; pipeline này là at-least-once, không cam kết exactly-once.

#### Chạy thử tải có giới hạn

Trên máy local/staging của bạn, sau khi Redis, credentials và server đã chạy:

```powershell
$env:MATCH_RESULTS_TEST_TOKEN = $env:MATCH_INGEST_TOKEN
$env:MATCH_RESULTS_TEST_COUNT = "10000"
$env:MATCH_RESULTS_TEST_CONCURRENCY = "25"
npm run load:test
```

Script gửi số request hữu hạn, mặc định chỉ tới localhost, giới hạn concurrency
tối đa 100 và retry `429`/`503` có backoff. Chỉ kiểm tra hệ thống bạn sở hữu;
để nhắm staging từ xa phải đặt rõ `ALLOW_EXTERNAL_LOAD_TEST=true` và URL test.
Tăng tải từng bước, theo dõi Redis queue depth, HTTP `503`, latency, RSS/CPU,
Sheets API errors và quota. Dừng thử tải nếu queue tiếp tục tăng hoặc server
thực tế bị ảnh hưởng.

#### Triển khai nhiều instance

Trên Linux, có thể dùng PM2 cluster cho API; Redis dùng chung đảm bảo worker
không đồng thời append từ từng process:

```bash
npm install --global pm2
pm2 start src/server.js --name boardgame-api -i max
pm2 save
pm2 startup
```

Đặt reverse proxy/load balancer với giới hạn body, TLS và rate limit theo token.
Không public Redis hay Service Account key. Với tải vượt khả năng Sheets, ghi
trận trước vào database/stream bền vững (PostgreSQL, Kafka hoặc Pub/Sub), sau
đó chạy consumer xuất bản tổng hợp/batch sang Sheets; một spreadsheet cũng có
giới hạn tổng số ô và không nên được xem như database.

Hoặc chạy Minimax ở cả hai bên:

```powershell
npm run bot:match -- classic 200 bots/minimax_bot.py bots/minimax_bot.py
```

Mỗi trận headless được lưu thành replay JSON trong `matches/`. Có thể chọn
đường dẫn file ở tham số thứ sáu:

```powershell
npm run bot:match -- classic 200 bots/minimax_bot.py bots/random_bot.py matches/minimax-vs-random.json
```

Replay có thể được đọc lại và kiểm tra bằng chính game engine:

```powershell
npm run replay -- matches/minimax-vs-random.json
```

Lệnh replay chạy lại từng nước đi, kiểm tra chúng vẫn hợp lệ và đối chiếu
người thắng với kết quả đã lưu.

### Giải đấu bot

Mở **🏆 Bot Tournament** từ sảnh để tải lên nhiều file `.py` (tối đa 1 MB mỗi
file), chọn bot, chế độ bàn cờ và giới hạn lượt. Thể thức mặc định là **Swiss +
playoff top 32**. Swiss chạy `ceil(log2(số bot))` vòng; mỗi vòng ghép các bot có
điểm gần nhau và tránh đấu lại đối thủ cũ. Sau Swiss, tối đa 32 bot đứng đầu
bước vào nhánh thắng và nhánh thua. Nhánh thắng thi đấu vòng 1/16, 1/8, tứ kết,
bán kết rồi chung kết nhánh thắng; bot thua rơi xuống nhánh thua và tiếp tục
thi đấu đến chung kết nhánh thua. Hai bot thắng ở hai nhánh gặp nhau ở chung kết
tổng. Trận hòa Swiss được nửa điểm mỗi bot; trận playoff và loại trực tiếp được
chạy lại tối đa 10 lượt để tìm người thắng. Chọn **Swiss · chỉ xếp hạng** để
không chạy playoff. Vòng tròn hai lượt vẫn có sẵn cho giải nhỏ.

Giải có thể có 2–10.000 bot. Tài khoản quản trị mới được tạo giải trên 20 bot;
đăng nhập bằng tài khoản `ADMIN_USERNAME`. Với 10.000 bot, thể thức mặc định
chạy 14 vòng Swiss và 62 trận playoff (70.062 trận tổng cộng). Máy chủ chạy hai
trận cùng lúc mặc định; đổi mức này bằng `TOURNAMENT_CONCURRENCY`. Một giải lớn
có thể chạy rất lâu và cần đủ CPU, RAM, dung lượng đĩa và Docker Engine trên máy
chủ. Build image bot runner một lần theo phần **Bảo vệ khi chạy bot không đáng
tin** ở trên. Không chạy bot của học sinh trực tiếp trên host.

Danh sách giải hiển thị trạng thái và tiến độ; mở chi tiết để xem bảng xếp hạng,
lọc lịch đấu theo vòng, xem sơ đồ nhánh thắng/nhánh thua/chung kết tổng và phát
lại từng trận. Sơ đồ có nút **Mở rộng** để xem toàn màn hình và **Vừa khung** để
thu toàn bộ cây đấu vào một khung nhìn. Replay giải được nén trên đĩa và máy chủ
giải nén khi trình duyệt phát. Tiến độ có thể khôi phục sau khi khởi động lại
server.

Thể thức **Vòng tròn hai lượt** giữ nguyên cách cũ: mỗi cặp bot đấu hai ván,
đổi bên P1/P2 ở ván thứ hai. Thắng được 1 điểm, hòa 0.5 điểm. Bảng xếp hạng,
tiến độ và replay được lưu trong `matches/tournaments/`; replay cũng xuất hiện
trong trình xem replay gần đây. Bot tải lên từ giao diện được lưu thành phiên
bản bất biến trong `bots/submissions/`.

### Giải cộng đồng do admin tổ chức

Admin mở `/admin.html`, tạo một giải đăng ký với tối đa 20 suất. Người chơi
đăng nhập rồi mở `/tournaments.html`, chọn một file Python và bấm **Đăng ký
bot** trong giải cộng đồng. Mỗi tài khoản chỉ được đăng ký một bot trong mỗi
giải; một submission cũng không thể được dùng bởi hai tài khoản. Admin có thể
bắt đầu khi có từ 2 đến 20 người; giải cộng đồng chạy Swiss và hiển thị tiến
độ, danh sách người chơi và nhà vô địch công khai.

Thông tin giải cộng đồng được lưu tại `matches/tournaments/community-events.json`;
file bot bất biến và metadata chủ sở hữu nằm trong `bots/submissions/`.

### Nhập và chạy giải offline từ Google Forms

Khi học sinh nộp bot qua Google Form, admin tải các file `.py` về một thư mục rồi chạy:

```powershell
npm run bot:batch -- C:\path\to\submissions --metadata C:\path\to\responses.csv --mode army --max-turns 300 --pool-size 20
```

Script sẽ:
- quét đệ quy thư mục và kiểm tra cú pháp Python bằng `python -m py_compile`;
- loại file rỗng, quá 1 MB, trùng nội dung và file không đọc được;
- đọc metadata từ CSV/JSON (cột tên file, tên, mã sinh viên, email) nếu có;
- chia bot thành các pool tối đa 20 bot và chạy Swiss cho từng pool;
- nếu có nhiều pool, chạy thêm giải chung kết với `--advance` bot đứng đầu mỗi pool;
- xuất `validation.json`, `standings-pool-*.csv/json`, `standings-final.*`, `summary.json`
  và thư mục `replays/` cùng `submissions/` đã đóng băng.

Các tùy chọn hữu ích: `--validate-only`, `--dry-run`, `--no-sandbox` (chỉ dùng cho bot tin cậy/
máy local), `--concurrency`, `--output`. Bot học sinh vẫn nên chạy trong Docker theo phần
**Bảo vệ khi chạy bot không đáng tin**; không dùng `--no-sandbox` cho mã không tin cậy.

Có thể tạo giải round-robin từ terminal với hai bot mẫu:

```powershell
npm run bot:tournament -- army 300 random minimax
```

Các chế độ hợp lệ: `classic`, `tactical`, `army`. Giới hạn lượt là 20–2000.

### Xem replay trên frontend

Khởi động server:

```powershell
npm start
```

Mở:

```text
http://localhost:3000/replay.html
```

Trang replay liệt kê các file trong `matches/` và hỗ trợ tải trận, phát/tạm
dừng, đi tới/lùi từng nước và thay đổi tốc độ. Có thể mở trực tiếp một file:

```text
http://localhost:3000/replay.html?file=bot-match-1792080020040.json
```

## Ghi chú asset

Các quân cờ và biểu tượng căn cứ là SVG để hiển thị sắc nét. Thư mục `assets/board`, `assets/vfx` và `assets/sfx` được giữ trong cấu trúc dự án để thay thế bằng texture, hiệu ứng và âm thanh sản phẩm sau này; giao diện hiện có fallback CSS và Web Audio đơn giản nên vẫn chạy không cần media nhị phân.
