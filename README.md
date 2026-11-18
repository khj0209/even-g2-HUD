# Drive HUD — Even Realities G2 운전용 HUD 플러그인

현대차 HUD(헤드업 디스플레이) 옵션에서 보던 정보를 Even G2 글래스에 띄우는 Even Hub 플러그인입니다.

| 현대 HUD 기능 | 상태 | 데이터 출처 |
| --- | --- | --- |
| 현재 속도 | ✅ | 휴대폰 GPS |
| 제한속도 표지 + 과속 경고 | ✅ | OpenStreetMap `maxspeed` (Overpass API) |
| 과속 단속 카메라 알림 | ✅ | OpenStreetMap `highway=speed_camera` |
| 턴바이턴 길 안내 (화살표 · 남은 거리 · 도로명 · 도착 시각) | ✅ | Tmap API(키 등록 시) 또는 OSRM 경로 + Nominatim 검색 |
| 시계 · 진행 방위 | ✅ | 휴대폰 |
| 크루즈 설정 속도, 차로 유지, 후측방 경고 등 차량 ADAS 정보 | ❌ | 차량 CAN 데이터가 필요해 휴대폰만으로는 불가 (OBD 동글 연동 시 일부 가능) |

## 화면 구성

화면은 하나로 고정돼 있고, 글래스 터치패드를 **두 번 탭**하면 종료합니다.

G2 화면은 시선보다 약간 위에 떠 있으므로, 모든 정보를 화면 **아래쪽 중앙의 한 덩어리**로 모았습니다. 도로를 보는 시선에서 가장 가깝고, 가장자리로 눈을 돌릴 필요가 없습니다.

```
                                       ┌──────────┐
                                       │ ─┼─┃─┼─  │  ← 미니맵: 주변 도로, 경로, 다음 회전, 목적지, 단속 카메라
                                       │  │ ▲ │   │
                                       └──────────┘
        테헤란로  3.0 km · 09:24 도착        ← 안내 중: 도로명·남은 거리·도착 시각 / 평소: 시계·방위
   ↱            46             (50)
 550 m         km/h          단속 600 m
 회전 안내      속도        제한속도 · 단속 카메라
```

미니맵은 진행 방향이 위로 오도록 돌아가며, 차는 아래쪽 가운데에 있어 앞쪽이 더 넓게 보입니다.

- 주변 도로: 큰길은 진하게, 골목은 흐리게 (OpenStreetMap)
- 길 안내 중: 경로(가장 밝은 선), 다음 회전 지점(동그라미), 목적지(네모)
- 단속 카메라: 마름모
- 속도에 따라 축척이 바뀝니다: 50 km/h 미만 약 130 m 앞까지, 90 km/h 미만 약 200 m, 그 이상 약 340 m
- 글래스 전송량 때문에 3초에 한 번 갱신합니다

제한속도를 넘으면 속도에 테두리가 생기고 표지 테가 굵어집니다. 도로에 제한속도 정보가 없으면 앞에 있는 단속 카메라의 제한속도를 표지에 씁니다. 기준(+0 / +5 / +10 km/h)은 휴대폰 화면에서 고릅니다.

## 개발

```bash
npm install
```

```bash
npm run dev
```

브라우저에서 `http://localhost:5173/?demo` 를 열면 GPS 없이 내장 데모 주행으로 HUD 미리보기를 볼 수 있습니다.

시뮬레이터(별도 터미널, dev 서버 실행 중):

```bash
npm run sim
```

실제 글래스(Even 앱 개발자 모드에서 QR 스캔):

```bash
npm run qr
```

테스트와 패키징:

```bash
npm test
```

```bash
npm run pack
```

`npm run pack` 은 `drive-hud.ehpk` 를 만듭니다. 업로드는 `evenhub login` 후 `evenhub create` / `evenhub upload` 를 사용합니다.

## 배포 (GitHub Actions)

`.github/workflows/release-beta.yml` 이 패키징 → Even Hub 업로드 → 베타 지정을 합니다. `app.json` 의 `version` 을 올린 뒤
GitHub의 Actions 탭에서 **Release to Even Hub beta** 를 실행하면 됩니다.

처음 한 번만, 맥에서 로그인한 뒤 로그인 정보를 저장소 시크릿으로 등록합니다.

```bash
npx evenhub login
```

```bash
pbcopy < ~/.config/evenhub/credentials.yaml
```

GitHub 저장소 → Settings → Secrets and variables → Actions → New repository secret 에서 이름을
`EVENHUB_CREDENTIALS` 로 하고 복사한 내용을 붙여넣습니다. 로그인이 만료되면 같은 과정을 다시 하면 됩니다.

## 구조

```
src/
  core/      타입, 좌표 계산, 표시 형식
  services/  위치(Even 앱 · 브라우저 · 데모), 도로 데이터(제한속도 · 카메라), 경로 안내
  hud/       화면 모델(view) → 컨테이너 배치(layout) → 그리기(draw) → 글래스/미리보기 출력
  app.ts     전체 조율
  main.ts    휴대폰 설정 화면
```

G2 제약에 맞춘 설계:

- 화면은 576×288, 이미지 컨테이너는 200×100 이하로 유지
- 글래스 글꼴은 크기 조절이 안 되므로 속도·표지·화살표는 비트맵으로 그려 전송
- 이미지 전송은 느리고 동시 전송이 안 되므로, 바뀐 컨테이너만 한 번에 하나씩(최신 값 우선) 전송

## 알아둘 점

- 제한속도·단속 카메라는 OpenStreetMap 데이터라 누락되거나 실제와 다를 수 있습니다. 태그가 없는 도로에서는 표지가 표시되지 않습니다.
- 기본값은 공개 데모 서버(OSRM, Nominatim)이며 현재 위치가 이 서버들로 전송됩니다. 휴대폰 화면의 "경로 안내" 설정에서
  [openapi.sk.com](https://openapi.sk.com)에서 발급받은 개인 Tmap 앱키를 입력하면 경로 탐색·목적지 검색이 Tmap API로
  전환되어 국내 도로 정확도가 더 좋아집니다. 키는 `localStorage`/Even 앱 로컬 스토리지에만 저장됩니다.
- 실제 글래스에서는 아직 검증하지 않았습니다(시뮬레이터 0.9.5에서 확인).
- 주행 중에는 휴대폰을 조작하지 말고, 항상 도로 표지판을 우선하세요.
