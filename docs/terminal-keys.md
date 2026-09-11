# Customize terminal keys

Open **Settings → Terminal keys → Customize terminal keys**. The preview updates
as you edit. Use the arrows beside a key to change its order, **Row 1 / Row 2**
to move it, **×** to hide it, and **Add a key** to bring back a hidden key or add
another shortcut. **Restore default keys** restores the full default layout.

- The four arrow keys, **Enter**, and the **Show/Hide keyboard** button stay fixed.
  The arrows form an inverted T and do not move when the tools scroll.
- The first row has room for five configurable keys. The second row scrolls
  horizontally; fades at its edges indicate more keys offscreen.
- The defaults put **Ctrl+C** at the far left, away from Enter. If you move it,
  leave enough separation to avoid interrupting a process by mistake.
- Preferences are stored locally, not in your Hub account. Browser storage is
  scoped to the Hub's origin; encrypted App connections use the App's local
  storage. Clearing App/browser data resets the layout.

## Shift and deletion

**Shift+Tab** sends the backward-tab sequence in one tap. Programs such as
interactive coding agents decide what that sequence does.

Tap **Shift** to modify the next key, or hold it while tapping other terminal
keys for continuous combinations. Its highlight shows when it is active.
Tapping an armed Shift again cancels it. Releasing a hold ends that hold; changing
terminals, losing control, reconnecting or backgrounding clears modifiers.
Shift supports Tab, arrows, Home/End and single ASCII characters. It does not
rewrite composed Chinese text or a multi-character paste.

**Backspace** deletes the character before the cursor, like the usual Mac Delete
key. Hold it to repeat. It sends the conventional terminal backward-delete byte
(`0x7f`), not the forward-delete sequence. A terminal program or custom shell
binding may assign it another action. Swiping across the scrolling row does not
delete text.

**Ctrl** remains a one-shot modifier: tap it, then the next key. For example,
Ctrl followed by a letter sends the corresponding control character.

Only **Show keyboard** explicitly opens the system keyboard. The other command
keys do not focus the input. If the keyboard is already open, you can keep typing;
after closing it with the keyboard's own hide button, terminal keys keep it closed.

## Updating

Encrypted connections use the frontend bundled inside the App. Update the App
to get new terminal controls. Ordinary browser/legacy direct connections use
the frontend served by the Hub, so update the Hub for those connections.

## 中文说明

进入 **Settings → Terminal keys → Customize terminal keys**：可隐藏、添加、排序、
调整按键所在行，并实时预览；**Restore default keys** 恢复默认布局。

方向键、Enter 和键盘开关固定。第一行最多 5 个自定义键，第二行横向滑动。
建议把 Ctrl+C 留在左侧，与 Enter 隔开。设置保存在本地；普通浏览器按 Hub 域名分别保存，
加密 App 连接使用 App 的本地存储，清除数据后会恢复默认。

- **Shift+Tab**：单独点按即可发送反向 Tab。
- **Shift**：点按修饰下一个键，或按住它连续组合其他按键；再次点按可取消待用状态。
  按住后松手、切换终端、失去控制权、重连或进入后台时会清除状态。
- **Backspace / 退格**：删除光标前的字符，长按连续删除，与 Mac 常用 Delete 键方向相同。
- **Ctrl**：点按后修饰下一个键。

除键盘开关外，命令键不会主动唤起系统键盘。加密连接需更新 App 才能使用新界面；
普通浏览器或旧式直接连接需更新 Hub。
