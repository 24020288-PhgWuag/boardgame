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

Admin mở `/admin.html`, tạo một giải đăng ký với tối đa 12 suất. Người chơi
đăng nhập rồi mở `/tournaments.html`, chọn một file Python và bấm **Đăng ký
bot** trong giải cộng đồng. Mỗi tài khoản chỉ được đăng ký một bot trong mỗi
giải; một submission cũng không thể được dùng bởi hai tài khoản. Admin có thể
bắt đầu khi có từ 2 đến 12 người, hệ thống tự tạo bracket loại trực tiếp và
hiển thị tiến độ, danh sách người chơi và nhà vô địch công khai.

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
