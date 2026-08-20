#!/bin/sh
# Lượt quét watcher cho aaPanel → Cron → Shell Script (mỗi 1 phút).
#
# Dùng file này khi không muốn đụng systemd. Nhược điểm: aaPanel cron nhanh nhất
# là 1 phút, nên đơn trả bằng QR có thể mất tới 1 phút mới chuyển sang confirmed.
# Muốn 15 giây thì dùng deploy/systemd/kolo-watcher.timer.
#
#   chmod +x /www/wwwroot/pay.bboapp.xyz/deploy/watcher.sh
#   printf 'PAYMENT_WATCHER_SECRET=...\n' > /etc/kolo-watcher.env && chmod 600 /etc/kolo-watcher.env
#
# Secret nằm ở file riêng chứ không viết thẳng vào ô lệnh của aaPanel: lệnh cron
# hiện nguyên văn trong danh sách tiến trình (`ps aux`) của mọi user trên máy.

set -eu
. /etc/kolo-watcher.env

curl -fsS --max-time 60 -X POST \
  https://pay.bboapp.xyz/api/payments/watcher \
  -H "authorization: Bearer ${PAYMENT_WATCHER_SECRET}" \
  -o /dev/null
