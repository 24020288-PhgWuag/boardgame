# OTT V2 Multiplayer Game

Game co-op 2 người trên bàn 9x9. Người chơi di chuyển quân theo 8 hướng; khi đi vào ô có quân đối phương, luật kéo-búa-bao quyết định bên thắng.

## Chạy local

```bash
npm install
npm start
```

Mở `http://localhost:3000` trong hai tab trình duyệt. Một người tạo phòng, người còn lại nhập mã phòng.

## Kết nối bot qua WebSocket

Server hỗ trợ bot điều khiển một slot `p1` hoặc `p2` trong phòng hiện có. Bot gửi:

```json
{ "type": "bot_join", "code": "MÃ_PHÒNG", "name": "my-bot" }
```

Server gửi `INIT`, sau đó gửi `TURN` mỗi khi đến lượt bot. Bot trả lời trong tối đa
1.000ms bằng:

```json
{
  "type": "bot_move",
  "from": { "row": 0, "col": 0 },
  "to": { "row": 1, "col": 1 }
}
```

Nước đi vẫn được kiểm tra bởi server qua cùng engine với người chơi trên web.
Bot quá thời gian sẽ thua lượt đấu. `TURN` bao gồm `pieces` và `history` để bot
phân tích các nước đi trước đó.

Giữa hai nước bot có độ trễ mặc định 1.000ms để dễ theo dõi trên giao diện.
Có thể thay đổi khi khởi động server:

```powershell
$env:BOT_MOVE_DELAY_MS="2000"
npm start
```

Sau khi tạo phòng bằng giao diện, chạy bot ở hai terminal:

```powershell
$env:BOT_URL="ws://localhost:3000"
$env:BOT_ROOM="MÃ_PHÒNG"
$env:BOT_NAME="random-bot"
npm run bot:random
```

Đổi `BOT_NAME` và chạy `npm run bot:greedy` ở terminal thứ hai. Nếu dùng phòng
đang có người chơi, bot sẽ tự nhận slot còn trống; nếu đủ hai slot, bot được
tham gia dưới dạng spectator và không thể gửi nước đi.

## Ghi chú asset

Các quân cờ và biểu tượng căn cứ là SVG để hiển thị sắc nét. Thư mục `assets/board`, `assets/vfx` và `assets/sfx` được giữ trong cấu trúc dự án để thay thế bằng texture, hiệu ứng và âm thanh sản phẩm sau này; giao diện hiện có fallback CSS và Web Audio đơn giản nên vẫn chạy không cần media nhị phân.
