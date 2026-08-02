# Firefox更新配布

Firefoxは`manifest.json`の`update_url`から`updates.json`を取得し、より新しいバージョンがあれば署名済みXPIをダウンロードします。

## 初回の署名

1. `main`ブランチに`updates.json`を含む変更を反映する。
2. Mozilla Add-on Developer Hubで「On your own」を選び、拡張機能を署名する。
3. 署名済みXPIをGitHub Releasesへ`v0.1.0`としてアップロードする。
4. XPIをFirefoxの「ファイルからアドオンをインストール」からインストールする。

## 次のバージョンを配布する場合

1. `manifest.json`の`version`を上げる。
2. Mozillaで署名したXPIをGitHub Releasesへアップロードする。
3. `updates.json`の`updates`配列に新しいバージョンを追加する。

```json
{
  "addons": {
    "ole-focus-pause@example.local": {
      "updates": [
        {
          "version": "0.1.1",
          "update_link": "https://github.com/Shonese/OLE/releases/download/v0.1.1/ole-focus-pause-0.1.1.xpi"
        }
      ]
    }
  }
}
```

`update_url`はインストール済みの拡張機能に保存されます。URLを変更すると既存のインストールは新しい更新先を自動的に見つけられないため、URLは維持してください。
