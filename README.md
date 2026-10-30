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

Tải bot lên và đăng ký giải cộng đồng yêu cầu đăng nhập. Mỗi tài khoản được lưu
tối đa 5 bot; giới hạn tải lên là 5 lần/phút cho mỗi tài khoản và 10 lần/phút
cho mỗi địa chỉ IP. Tệp nguồn tối đa 256 KiB. Bot tải lên và bot đăng ký giải
cộng đồng không được chạy trực tiếp bằng Python trên host. Tạo image runner một lần:

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
kiểm tra trong production. Giới hạn upload theo IP hiện lưu trong bộ nhớ của
một tiến trình; nếu chạy nhiều server, cần dùng rate limiter dùng chung. Tiếp
tục giám sát tải bot và dọn container sau trận.
Mỗi bot được gắn với chủ sở hữu và lưu SHA-256; server xác minh checksum trước
khi chạy để phát hiện tệp bot bị thay đổi ngoài luồng upload.

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

### Phục hồi phòng, scale nhiều instance và giám sát

Để lưu trạng thái phòng PvP và hàng đợi tìm trận dùng chung giữa các process,
cấu hình `ROOM_STATE_REDIS_URL` trỏ tới Redis có persistence. Server lưu snapshot
phòng, đồng bộ sự kiện WebSocket và dùng khóa Redis khi xử lý join/nước đi; phòng
có thể được khôi phục sau khi process khởi động lại trong tối đa 24 giờ. Hàng chờ
tìm trận hết hạn sau 10 phút. Bot process không được tự khởi động lại từ snapshot;
trận bot đang chạy cần bắt đầu lại sau khi server restart.

Các instance phải dùng chung Redis và database SQLite trên cùng host/storage
được hỗ trợ; không đặt file SQLite trên NFS. Triển khai nhiều máy cần chuyển
tài khoản/session sang database server trước. Khi đặt sau load balancer, bật
sticky session để WebSocket của cùng người chơi được chuyển tới cùng instance.
Dùng TLS/WSS ở reverse proxy; cookie có cờ `Secure` khi `NODE_ENV=production`.
Redis không được public ra Internet. Nếu Redis không cấu hình, server chạy chế
độ một process và in cảnh báo về việc không có phục hồi/chia sẻ trạng thái phòng.

Mở `/admin.html` để xem số WebSocket, phòng, RAM, CPU và uptime; API metrics yêu
cầu tài khoản admin. Metrics là số liệu của process hiện tại. Các trận bot tương
tác giới hạn tối đa 8 tiến trình trên mỗi instance để tránh tạo tải CPU/RAM không
giới hạn. Giá trị CPU là mức sử dụng tiến trình Node giữa hai lần lấy mẫu dashboard.

Chạy tải WebSocket có giới hạn trên localhost hoặc staging bạn sở hữu:

```powershell
$env:WS_LOAD_TEST_CLIENTS = "1000"
$env:WS_LOAD_TEST_RAMP = "50"
$env:WS_LOAD_TEST_DURATION_SECONDS = "30"
npm run load:ws
```

Script mặc định chỉ kết nối loopback, tối đa 10.000 client và 5 phút. Để thử
staging từ xa, đặt rõ `ALLOW_EXTERNAL_LOAD_TEST=true` và `WS_LOAD_TEST_URL`.
Tăng tải từng bước; theo dõi metrics, latency và lỗi trước khi tăng số client.
Stress test này kiểm tra WebSocket/ping/list phòng, không đại diện cho tải bot
hay lưu lượng gameplay thực tế.

### Trang quản trị

Tài khoản Admin được tạo riêng từ cấu hình môi trường khi khởi động server.
Đặt cả tên và mật khẩu (mật khẩu dài 8-128 ký tự):

```powershell
$env:ADMIN_USERNAME = "quangphuong"
$env:ADMIN_PASSWORD = "mat-khau-quan-tri-rieng"
npm start
```

Sau đó mở `http://localhost:3000/admin-login.html`. Admin dùng cookie phiên
riêng, tách khỏi phiên người chơi; tài khoản người chơi không thể đăng nhập vào
trang hoặc API quản trị. Đổi `ADMIN_PASSWORD` rồi khởi động lại để thay mật khẩu.
Hãy dùng tên tài khoản Admin chưa được tài khoản người chơi đăng ký; server sẽ
từ chối tự nâng quyền một tài khoản thường. Không đưa mật khẩu thật vào Git.
Đăng nhập Admin ngay trong hộp thoại đăng nhập ở trang chơi cũng được; sau khi
đăng nhập, nút **🛡️ Quản trị** xuất hiện trên thanh đầu trang và mở popup quản trị
ngay trong giao diện game (đóng bằng nút ✕, phím `Esc` hoặc bấm ra ngoài popup).
Popup hiển thị metrics, danh sách tài khoản và cho phép tạo/bắt đầu giải cộng
đồng. Tài khoản Admin không xuất hiện trên bảng xếp hạng người chơi.

### Giao diện hoạt hình (playful cartoon)

Toàn bộ trang (sảnh, bàn cờ, giải đấu, replay, đăng nhập Admin và popup quản trị)
dùng chung theme trong `public/css/playful.css`, được nạp sau cùng trong mỗi
trang HTML để ghi đè style nền. Theme dùng font Fredoka/Baloo 2 (có fallback hệ
thống khi offline), bảng màu pastel, nút 3D có viền đậm, hiệu ứng nảy khi hover/click
và linh vật SVG tại `public/assets/stickers/mascot.svg`. Hiệu ứng chuyển động tự
giảm xuống mức tối thiểu khi hệ điều hành bật `prefers-reduced-motion`. Muốn đổi
màu, chỉnh các biến `--mint`, `--orange`, `--sun`, `--pink`, `--outline`... ở đầu file.

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

Mở **🏆 Bot Tournament** từ sảnh để chọn 2–12 bot, chế độ bàn cờ, thể thức và
giới hạn lượt. Thể thức **Đấu loại trực tiếp** tự tạo bracket theo lũy thừa của
2 gần nhất; với 12 bot, 4 bot được bye ở vòng đầu, sau đó đấu tứ kết, bán kết
và chung kết. Trận hòa được chạy tối đa 3 lượt phân định; bot thắng được đi
tiếp và nhà vô địch hiển thị trên trang giải.

Thể thức **Vòng tròn hai lượt** giữ nguyên cách cũ: mỗi cặp bot đấu hai ván,
đổi bên P1/P2 ở ván thứ hai. Thắng được 1 điểm, hòa 0.5 điểm. Bảng xếp hạng,
tiến độ và replay được lưu trong
`matches/tournaments/`; replay cũng xuất hiện trong trình xem replay. Bot tải
lên từ giao diện được lưu thành phiên bản bất biến trong `bots/submissions/`.
Giải đang chạy sẽ tiếp tục từ trận chưa hoàn tất sau khi khởi động lại server.

### Giải cộng đồng do admin tổ chức

Admin mở `/admin.html`, tạo một giải đăng ký và chọn số suất tối đa từ 2 đến
10000 (mặc định 12). Người chơi
đăng nhập rồi mở `/tournaments.html`, bấm **Tham gia giải** để giữ suất trước;
sau đó tải bot lên cho suất của mình. Admin chỉ bắt đầu được khi có ít nhất 2
người (tối đa bằng số suất của giải) và tất cả đã tải bot. Mỗi tài khoản chỉ được tham gia một lần trong
mỗi giải; một bot cũng không thể được đăng ký bởi hai người. Hệ thống tự tạo
bracket loại trực tiếp và hiển thị tiến độ, danh sách người chơi và nhà vô địch.

Thông tin giải cộng đồng được lưu tại `matches/tournaments/community-events.json`;
file bot bất biến và metadata chủ sở hữu nằm trong `bots/submissions/`.

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
