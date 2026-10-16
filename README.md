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
với Bot và Pass & Play vẫn có thể bắt đầu mà không cần đăng nhập.

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
bằng cùng giao thức JSON Lines như các bot có sẵn. Bot phải đọc một JSON object
trên mỗi dòng từ `stdin`, trả về một JSON object trên mỗi dòng ở `stdout`, và
ghi log chẩn đoán vào `stderr`.

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

Mở **🏆 Bot Tournament** từ sảnh để chọn 2–12 bot, chế độ bàn cờ và giới hạn
lượt. Mỗi cặp bot đấu hai ván, đổi bên P1/P2 ở ván thứ hai. Thắng được 1 điểm,
hòa 0.5 điểm. Bảng xếp hạng, tiến độ và replay được lưu trong
`matches/tournaments/`; replay cũng xuất hiện trong trình xem replay. Bot tải
lên từ giao diện được lưu thành phiên bản bất biến trong `bots/submissions/`.
Giải đang chạy sẽ tiếp tục từ trận chưa hoàn tất sau khi khởi động lại server.

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
