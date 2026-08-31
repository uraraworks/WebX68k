// マウスの閉ループ追従(段階移行 手順6後半、docs/STORAGE-SCSI.md「ワーカー移行 手順6後半：
// マウス閉ループ追従の移行」参照)の純粋ロジック。
//
// 元々は src/main.ts に直接書かれていた(stepMouseTracking/resyncGuestMouse とその周辺の
// module-level 変数)。Worker経路(?worker=1)では入力の集約先が host(既定経路専用の
// メインスレッド LibretroHost)からWorker側の LibretroHost インスタンスへ移るため、閉ループ
// そのものをこのファイルへ切り出し、既定経路(src/main.ts)・Worker経路(src/core-worker.ts)の
// 両方がまったく同じクラスを別インスタンスとして使う。main→Worker往復を毎フレーム挟む方式
// (main が cursor を運んでもらって計算しdeltaを送り返す)は採らなかった: 閉ループが1フレーム
// 以上の遅延を持つと、ack待ち(MOUSE_TRACK_ACK_FRAMES)や stall 判定の前提が壊れて収束しなくなる
// ため(postMessageの往復遅延がそのまま閉ループの反応速度に乗ってしまう)。
//
// 既定経路の不変性(制約: 既定経路の挙動を一切変えない)は、このクラスを既定経路が直接使う
// (別の実装を用意して両方から呼ぶのではなく、旧 stepMouseTracking/resyncGuestMouse の中身を
// そのままこのクラスのメソッドへ移しただけ)ことで担保する。test/mouse-track.test.ts で
// 「切り出し前の関数と同じ呼び出し列に対して同じ delta 列を送ること」を検証する。
//
// 定数・加速カーブ(MOUSE_TRACK_ACK_FRAMES・MOUSE_ACCEL_TABLE・stall閾値90)は現行の値と挙動を
// そのまま移した。この機会に「改善」はしていない(変えると既定経路との差の原因が2つになるため)。

export interface GuestCursor {
  x: number;
  y: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  visible: boolean;
}

/**
 * MouseTracker が閉ループを回すのに必要な最小の host 構造型。
 * 既定経路は src/main.ts から src/libretro-host.ts の LibretroHost インスタンス(メインスレッド)を
 * そのまま渡す。Worker経路は src/core-worker.ts から同じ LibretroHost のWorker内インスタンスを渡す。
 */
export interface MouseTrackHost {
  readGuestCursor(): GuestCursor | null;
  hasPendingMouseDelta(): boolean;
  addMouseDelta(dx: number, dy: number): void;
  clearMouseState(): void;
}

/** カーソルが実際に動いたのを確認できるまで待つ最大フレーム数 */
export const MOUSE_TRACK_ACK_FRAMES = 12;
/** 安全弁: 目標に届いていないのにカーソルがまったく動かない場合、これを超えたら追従を諦める。 */
export const MOUSE_TRACK_STALL_LIMIT = 90;
/** IOCS ワークが読めないソフト向けフォールバックで、画面外まで押し切るための余白(ドット) */
export const MOUSE_HOMING_MARGIN = 64;

/**
 * IOCS のマウス加速テーブル(実測値)。[送信量, 実際に動くドット数]。
 *
 * IOCS は移動量に加速をかけるため、誤差をそのまま送ると**最大7.5倍に増幅されて行き過ぎ**、
 * 画面端から端へ発振する。3以下は加速がかからず 1:1 で、16 を境に急に倍率が上がる。
 * 逆引きして「予測移動量が誤差を超えない範囲で最大の送信量」を選べば必ず不足側に倒れるので、
 * 行き過ぎが原理的に起きない。残りは次フレーム以降の閉ループが詰め、最後は 1:1 の領域に
 * 入るのでぴたりと止まる。
 *
 * 加速の効き方は IOCS の設定で変わり得るが、この表は「行き過ぎないための上限見積もり」
 * としてしか使わないので、多少ずれても収束する。
 */
const MOUSE_ACCEL_TABLE: Array<[send: number, move: number]> = [
  [1, 1],
  [2, 2],
  [3, 3],
  [4, 5],
  [5, 6],
  [6, 7],
  [7, 8],
  [8, 10],
  [10, 12],
  [12, 15],
  [14, 17],
  [16, 40],
  [20, 50],
  [24, 90],
  [32, 160],
  [48, 360],
];

/** 目標移動量(絶対値)に対して、行き過ぎない範囲で最大の送信量を返す。 */
export function sendAmountFor(distance: number): number {
  const abs = Math.abs(distance);
  let send = 0;
  for (const [candidate, move] of MOUSE_ACCEL_TABLE) {
    if (move <= abs) send = candidate;
    else break;
  }
  return distance < 0 ? -send : send;
}

/** {@link MouseTracker.step} の戻り値。'disabled' はこの呼び出しで初めて追従を諦めたことを表す
 * (呼び出し側は利用者への通知(トースト)をこの戻り値をきっかけに1回だけ出す)。 */
export type MouseTrackStepResult = 'disabled' | undefined;

/**
 * 追従モードの閉ループ本体。ホスト側カーソルの canvas 内相対位置(0..1、setDesiredRatio)を
 * 目標として保持し、step() のたびにゲストのカーソル座標・可動範囲を host から読み、目標との
 * 差分を host.addMouseDelta() で送る。閉ループなのでホスト側で位置を推定する必要がなく、
 * ズレも自動的に吸収される。
 */
export class MouseTracker {
  private desiredRatioX = 0;
  private desiredRatioY = 0;
  private hasDesiredRatio = false;
  /** 追従が空回りしている(送っているのにカーソルが動かない)ことを検出するためのカウンタ */
  private trackStallFrames = 0;
  private trackDisabled = false;
  /** 送信後、カーソルが実際に動くのを待っている間の状態 */
  private trackAckPending = false;
  private trackAckFrames = 0;
  private trackSentAtX = -1;
  private trackSentAtY = -1;

  /** 診断・デバッグフック用。 */
  get ratioX(): number {
    return this.desiredRatioX;
  }
  get ratioY(): number {
    return this.desiredRatioY;
  }
  get disabled(): boolean {
    return this.trackDisabled;
  }

  /** canvas 内の相対位置(0..1)を目標として記録する。実際の送信は step() に任せる。 */
  setDesiredRatio(ratioX: number, ratioY: number): void {
    this.desiredRatioX = Math.max(0, Math.min(1, ratioX));
    this.desiredRatioY = Math.max(0, Math.min(1, ratioY));
    this.hasDesiredRatio = true;
  }

  /**
   * 追従モードの1フレーム分の追い込み(閉ループ)。呼び出し側(main.ts の loop()、
   * core-worker.ts の tick())は、実際にコアを1フレーム以上進めた回だけこれを呼ぶこと。
   *
   * @param host 閉ループの相手(既定経路はメインスレッドの LibretroHost、Worker経路は
   *   Worker内の LibretroHost)。
   * @param enabled 追従モードが今アクティブか(ENABLE_MOUSE_TRACKING && running &&
   *   !isMouseCaptured() 相当。既定経路は呼び出し側が直接計算する。Worker経路は
   *   pointer lock の状態を知る術がメインスレッドにしかないため、main から送られてきた
   *   値をそのまま渡す)。
   * @returns 'disabled' … この呼び出しで初めて追従を諦めた(host.clearMouseState() 済み。
   *   呼び出し側は利用者への通知をここで行うこと)。それ以外は undefined。
   */
  step(host: MouseTrackHost, enabled: boolean): MouseTrackStepResult {
    if (!enabled || !this.hasDesiredRatio || this.trackDisabled) return undefined;
    const cur = host.readGuestCursor();
    // マウスを使っていないソフトではワークエリアが初期化されていない。その場合は何もしない。
    if (!cur) return undefined;

    // 送った直後は、ゲストがまだ反映していない可能性がある。実際に動いたのを確認する前に
    // 次を送ると、同じ誤差に対して二重に送ることになって行き過ぎる。
    if (this.trackAckPending) {
      if (cur.x !== this.trackSentAtX || cur.y !== this.trackSentAtY) {
        this.trackAckPending = false;
        this.trackStallFrames = 0;
      } else if (++this.trackAckFrames > MOUSE_TRACK_ACK_FRAMES) {
        // 動かないまま待ち続けても仕方ないので、いったん待ちを解いて空回り判定に回す
        this.trackAckPending = false;
        this.trackStallFrames += MOUSE_TRACK_ACK_FRAMES;
      } else {
        return undefined;
      }
    }

    if (host.hasPendingMouseDelta()) return undefined;

    const targetX = Math.round(cur.minX + this.desiredRatioX * (cur.maxX - cur.minX));
    const targetY = Math.round(cur.minY + this.desiredRatioY * (cur.maxY - cur.minY));
    const dx = targetX - cur.x;
    const dy = targetY - cur.y;
    if (dx === 0 && dy === 0) {
      this.trackStallFrames = 0;
      return undefined;
    }

    // 安全弁: 目標に届いていないのにカーソルがまったく動かない(IOCS ワークを使わず
    // 自前でカーソルを管理するソフト等)場合、送り続けても無駄なので追従を止める。
    if (this.trackStallFrames > MOUSE_TRACK_STALL_LIMIT) {
      this.trackDisabled = true;
      host.clearMouseState();
      return 'disabled';
    }

    const sendX = sendAmountFor(dx);
    const sendY = sendAmountFor(dy);
    // 加速の下限(1ドット)未満しか誤差が無い軸は動かさない
    if (sendX === 0 && sendY === 0) {
      this.trackStallFrames = 0;
      return undefined;
    }

    host.addMouseDelta(sendX, sendY);
    this.trackSentAtX = cur.x;
    this.trackSentAtY = cur.y;
    this.trackAckPending = true;
    this.trackAckFrames = 0;
    return undefined;
  }

  /**
   * 強制的に基準を取り直す(ツールバーの「マウス再同期」)。閉ループ追従が効いていれば
   * 本来ズレないが、IOCS ワークを使わず自前でカーソルを管理するソフトのために、左上へ
   * 押し付ける従来のホーミングをフォールバックとして残す。
   *
   * @param avSize ホーミング距離の計算に使う画面サイズ(既定経路は host.avInfo?.baseWidth/
   *   Height、Worker経路は Worker側 host.avInfo の同じフィールドを渡す)。
   */
  resync(host: MouseTrackHost, avSize: { width: number; height: number }): void {
    // 止めていた追従を再開させる
    this.trackDisabled = false;
    this.trackStallFrames = 0;
    this.trackAckPending = false;
    if (host.readGuestCursor()) return; // 閉ループが効いているので押し付け不要
    const distance = Math.max(avSize.width, avSize.height) + MOUSE_HOMING_MARGIN;
    host.addMouseDelta(-distance, -distance);
  }
}
