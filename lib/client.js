// dsh-subagent-role-router client — settings panel for the subagent default model.
// Extracted from @aaravarr/dsh-subagent-max (licensed MIT) and adapted as a
// standalone client entry for this plugin.

window.__ModuleLoader__.load({
  id: "dsh-subagent-role-router",
  factory: function (require) {
    var React = require("react");
    var primitives = require("@deepseek-ai/dsh-client-ui-primitives");
    var Toast = primitives.Toast;
    // ── 图标族适配（DSH 0.1.7 起重命名）──────────────────────────────────
    // 旧命名以尺寸为后缀（IconChevronDownOutline14），新命名改为粗细语义后缀
    // （IconChevronDownOutlineRegular / …Medium）。按名探测取第一个可用的，
    // 全缺失时由使用点渲染自绘字形——把 undefined 直接交给 React.createElement
    // 会在渲染期抛错。
    var IconChevronDown = primitives.IconChevronDownOutlineRegular
      || primitives.IconChevronDownOutlineMedium
      || primitives.IconChevronDownOutline14
      || null;
    // Native floating-surface primitive — the same panel the host's model
    // picker renders through a portal (surface background, elevation shadow
    // and stroke all come from it, so themes apply verbatim). react-dom is
    // only needed for the portal; both are optional with a fallback below.
    var MenuSurface = primitives.MenuSurface || null;
    var ReactDOM = null;
    try { ReactDOM = require("react-dom"); } catch (_reactDomAbsent) {}
    var canPortal = Boolean(MenuSurface && ReactDOM && typeof ReactDOM.createPortal === "function"
      && typeof document !== "undefined" && document.body);

    // ── GitHub 页面（「鼓励一下」链接目标） ──────────────────────────────
    var DSM_GITHUB_URL = "https://github.com/dingminhua/dsh-subagent-role-router";

    // ── 客户端构建标记（诊断用）──────────────────────────────────────────
    // 出现在设置卡常显的 [diag] 行里。保存失败排查期间，它回答「页面到底
    // 跑的是哪一个 client bundle」——宿主在启动时快照 bundle，页面可能仍
    // 持有旧版本；一眼对出构建号即可排除/坐实这一点。每次改 client.js
    // 排查时必须递增它。
    var DSM_CLIENT_BUILD = "2026-11-09.1";

    // Diagnostics are opt-in. The always-on version posted one line per poll
    // (every 1.2s for the critters, every 5s for each picker) and grew the log
    // past 7MB without adding information after the first line of a kind.
    // Enable with localStorage["dsh-subagent-role-router:log"] = "1" (or ?srrLog=1)
    // when a real question needs the trail; with the switch off the client
    // posts nothing at all.
    var SRR_DEBUG_KEY = "dsh-subagent-role-router:log";
    function srrDebugEnabled() {
      try {
        if (typeof window === "undefined") return false;
        var store = window.localStorage;
        if (store && store.getItem(SRR_DEBUG_KEY) === "1") return true;
        var href = String((window.location && window.location.href) || "");
        return /(?:^|[?&])srrLog=1(?:&|$)/.test(href);
      } catch (_e) {
        return false;
      }
    }
    function srrLog(tag, data) {
      try {
        if (!srrDebugEnabled()) return;
        var payload = { tag: tag, data: data, url: window.location.href, ts: Date.now() };
        if (typeof fetch === "function") {
          fetch("./subagent-role-router/debug", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload)
          }).catch(function () {});
        }
      } catch (_e) {}
    }
    /**
     * Which slot surfaces actually exist in the composer the user just touched?
     *
     * A child conversation is rendered through a CHAIN slot
     * (`conversation.composer`); any elected chain entry replaces the whole
     * composer bar, and with it the `conversation.input.right` outlet this
     * plugin registers into. When that happens the picker can never mount, and
     * no mount-time log inside the component can say so — the component is
     * never called. Reading the `[data-slot]` names inside the clicked
     * composer card answers the question from the user's own machine.
     */
    function composerCensus(target) {
      try {
        var card = null;
        try { card = target && target.closest ? target.closest("[data-composer-card]") : null; } catch (_a) {}
        if (!card && target && target.closest) {
          try { card = target.closest("[data-conversation-region='composer']"); } catch (_b) {}
        }
        if (!card && typeof document !== "undefined" && document.querySelector) {
          card = document.querySelector("[data-composer-card]");
        }
        var slots = [];
        if (card && card.querySelectorAll) {
          var nodes = card.querySelectorAll("[data-slot]");
          for (var i = 0; i < nodes.length; i++) {
            var name = nodes[i].getAttribute("data-slot");
            if (name && slots.indexOf(name) === -1) slots.push(name);
          }
        }
        var anchors = [];
        if (typeof document !== "undefined" && document.querySelectorAll) {
          var chain = document.querySelectorAll("[data-chain-overlay-fallback]");
          for (var j = 0; j < chain.length; j++) anchors.push(chain[j].getAttribute("data-chain-overlay-fallback"));
        }
        return {
          slots: slots,
          hasComposerCard: Boolean(card),
          mineOnPage: Boolean(typeof document !== "undefined" && document.querySelector && document.querySelector("[data-live-route]")),
          chainAnchors: anchors
        };
      } catch (_e) {
        return null;
      }
    }

    try {
      srrLog("CLIENT_BUNDLE_LOADED", { build: DSM_CLIENT_BUILD });
      if (typeof window !== "undefined" && !window.__srrClickHooked) {
        window.__srrClickHooked = true;
        window.addEventListener("click", function (e) {
          try {
            var target = e.target;
            if (!target) return;
            var txt = (target.innerText || target.textContent || "").trim().slice(0, 40);
            var cls = typeof target.className === "string" ? target.className : "";
            if (cls.includes("model") || cls.includes("route") || cls.includes("dsm") || cls.includes("claude") || txt.includes("Flash") || txt.includes("GLM") || txt.includes("dnq") || txt.includes("Gemini")) {
              srrLog("SUSPECT_CLICK", { tag: target.tagName, cls: cls, txt: txt, census: composerCensus(target) });
            }
          } catch (_eClick) {}
        }, true);
      }
    } catch (_eTop) {}

    // ── plugin icon (LD brand logo, 64px) ────────────────────────────────
    var DSM_ICON = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAXGUlEQVR4nH1bC7BdVXn+1tr7nHPvzb3JvUloSAQp0JHWoAMttKOCFrWU8irQSbCTQYG21IahnTJUUTsM0FJhZCzCSIcKImOpDkhrhQ5YC7ROB3lUBU3EyCuBFBIIedzcx3ntvTr/a621TwIns3PO3mfvddf/+v7v/9c6DvYKoYBz1cZNYfJpVBcNBm7dcIhj3TBM15VzqAE6XAWEGggVADroOl0byDW+PtRr9E732rl9r2PxOMNsrCogVE7PA0Kge4Lcz5/TGI6v00UaK+h98u4QUA9quIDg4Pe2i2LTsknc++mzZu9cv37VHNaFAveSJICj/9aFUNzrXHXSTwdnznl/Y+X9MaEP1D0A/ToKaUdDASoAK0YVYcLad/G88S6C1aQcOkI2Nj9HylBFBRMYqPUeFp6EDXQfKcIUoud6LQQP59rwrsBEOdhy9KGDK/7j9mUPmBKcCf++Z4YbF6eKLw+6QFioKl/DoYILlXMsHE2KPCCzwlsqoNb3oUw4Kq+2a0k4G4MtXOX3J4HNyulzUkC0eqYI8ZAaQZQSAh9080Qx1m7jHStnL/3B3ctvXbcuFOwBH/p5OG12DA/29leV6wcHeI8hadE1rBldl/6ACs7WMEuz0PIcKawe0Gdzeyf36eTzcOHxVAEpTEQB0QtY0PRZPMYsX+t3tSqBxkteYeHh6qqu6yIsmVhaHHtE7/fu/8fJhzzF/OywunXQR+DJOO9pkLp2NJ64pIXhaOxb/IfmJM29PemSJ+NSzJP1s2dhwmucJ6uaoIYFzVjnkFDhLRTkb2XC03gQTKDrZNjSV1icXwzPv9y99Z5Hw6R/psQnqoniyLBQ1d65IoGiDqZuHwWwzyFzx8xl5RDBZR4uCZc9E8fS+8TdSfHZ2KxAel6VwEIYZiflxC9NKToeKcKrAcjV2d2DK3xYqOcXJ478ytf2fcL3htWGegAaSZGeBnKixWgVPXRiZpEomLq4Kcri2RCc7zN3NWuq5XlOJLwqjq9liqlHlEfzSveIdVk0Fjh5kVjdjKLneniCtcEg7N492FBWAWvrHpwLzgmYUfySi+VorcJFBE6I7jIAjFnC3DybePKE5ClxLLsPI0q3kNAsYJ4g1wjkzDuju4nQJrx6RxRe/7YHfFX3MOyHtaUHloaKcqa4rcQTDWxubHnZ0lESNoaGXad7+RmLc7GMxbS4s8Y82S3mdhMshR+Po4pk181jkx22afHc8hL3plNTjOGDjEfu7pxfWkpcyA02Ofo6xpylPsMCi3eNTROShVawM0H4+4bXaGqzcTKQzc8j6VGPkb9tFtU56bwlBdK9ZMQMKNgolMtVKepFcq6hBMAzQJAQ6srG9iwNJRfN0LtWd64z1qZjRPDieBYQkyNTqFpCsoYoKQFoFt8xhA5icZ2fXWOwY4GScsT95Tv7XoSnd0ehgLJBSPSdkdhYWbSeAk2eCSzuScDs/qQo9dpRZarVWWm5ZRuxn8YRRabYtiwhn5PVRXD9js8FzM2rowKII7MnOJSR2GSZJMVUckfzjIjKMe2p5fOsENGfPESR38AwB8AsZTUBUV025TwWVEAsubSl6gYA8rU6eUMmvE2ErjMrQEDZQGkewGI6TcqPAhlT1hHBBV0xZC/R3B09JFmdXDESrIz5GRPMlWQA6kNAoVbjf7FAyq1vsW8xrt+rImI4aEiwIuqAMjI9y/8Z5RSAS+f04P4uTcihozDLaO6kZup2gSWFIXjm3plb75sHxkugMKzAgWmQcYmsTvqrgPkuMOgHFAhY0gnolDJfOgTM0t/xMcYTJeZz9QZRgHiUd5AQIHe2fNqIY3o4xiEw3wc++A6HvzweWNbWtKmsrF853PFEwDd/LEqoVOiYQQLQ7QGXn+Zw3okOhc9i1tw8umpS7mBQ4PW9Ab/YVuHxTTV+8EyF7TsqTHQCxtsBlVWSUVBViGYHcnMDQvaUyAv03wmPDcP8ECiy2lwOKl4CFz2+AoYDx1b73rkOayaVfUXziRMu9oGTbg54cz9pNlV9FEJzi8CJv+zwwOWWoZvZfXSst3rteDPgXx4e4LZv9fDS9grLlzotkclDakmXJCCFTswAdC5eZQqphwErZgr40QInAh4XHMbsHGt6ugSmWuLZwyqwlclFhwqOrSJgZky+izydc7bj+1ZPy7P9AT2nz/MR+PuK/g6/50fg8QdDGffQFQ4b13fwyFcmccl5HczOUgVYoXTcAGEBSWBzdRY4hoLUBvGeQGFgrM84gMWglq/mwszXqcSlAahgdi57l8/Mr9gaxiqbnZwheZMU23Lw88zN0zWff5ZzCpeyAApqTNWkjBorljnceMUEbvnMEqK0qIc1A6UAnYQS5/6Md4jTNxlhGUkKRYYBHmHCiEewJxQjzmmenFdphiXsZ0aKstogvmwkEiqwYml6MmS6kQkQKcUlICsIY6hyDAEbzupgZgr448/OouyI5Y3t8YgGfq5OIaHfeiZDWXclFizWw1OmF0lRQ4A8UWevnPTEsTNFjoQ7fV0UDq3SoSyBVgmU/FmOVsuz9VmfrCUBMPIMut4f1Dj9tzv4wqcmORzIvW1qwgOcYIC5vB0gzAClQW1EGuJXkgql2MlyuTHFhg4OAlrm8vRxtHrMFUhRV4trv/hawK3fqbF/QSwoYwSUPuCwlcDJ7y3wgeMKFHAYDgN7gOmwLBwGgxobzhnH/z7Txz9/exErpz2HK1teUZ+tTSGXZYZCFGAc3eqBZsESmZs1L0e92HK5TikSKA2N2CMY8QATfuvOgLOvqrBlW0CnyOioeWVF1/v4rXd7/M2fjeGEtQWGFO+FpkzFFPKOv/7zKXz/sR5m99foUJ2rRRNhhwCfAqBOxQkbVObHKSv14UZb2KnFdBAl5CdxvMwDcnotrTsW/vW9wPnXVdi2M+DwQ4DVK4CZSWDFVDp+aRkwNR7wxE8GOOuyWdz3vT7K0jMGyN8ToKTzFTMel2yYwPxcAJe56voR/eO7tOscY0Ls2GSFkJW+Nue8QTn6agJD6gta5mhwf7mHhCdesOGGCpu3AmMthzv+qsTHf6fArj0SP5YGKXNQZpleArRcjU9ePYdHnxgwPrAStK1EXkBhvO7scRx+aIleL2SWTzFP1qdQYkCs6dx66COob/28mB61GjzACwhmc9Q2rxnt/9GfUGwY1g4XfbHG488GjLWAmzYWOOU4zwAoKG6KteYG8YSAdunQKQM+dcMc9uwLbHnRv9Baumf5dIGPnNTB4jx5gQjNgisNLuH0Gr07ygKpjpdKsFnWGiuMXtLwfaPDpoRk/dFqjcYht6Q7P3lzhQefqvn87y4usOEjkgpjYlHhyT2psjMLErOcHANe3DbAXfd1xfUZVzRH6qMf/VA7E15JkfECdX9TiB+11ughDcisQGr4+wEfDqzrtegRxAau+aca3/gvEejK8z0uOcNhsUfWtAJGviOhrWKLXRwujgImx4Fvf3cR3V7gLGBRyDnfBbxnbQurVlImqJlEmdtLSpS/I9dACpD0l+I+sTjLCNbLe3sekHlEJry5/tJxh/98usZtDwo1vfTsAp/+mMeA0hrnPssalgl0PtoEEUYn18fbDltfHmLzlgEcs0MtiZ0oY+UKjyPWlBj0lRVGy3s+J2VQreKZIGUWq7MFDMEBaW01yMyoC7iRwmikG0zaZo5BcTwE9s0FXPS7Hp+/2DO356rQquKsvy9NDWV2yuXlM4Eb0O8FbN4ieTnCheIAKWLNao9qKPm/gJdD6bfhQkHlMLE9QmouF7Mlq1geM/hpO2xU/oNciT2K2B0Wik1/cHYu4Jz3O9y80bNXCOAJfnCzRAeguUhxbF0e7eLwMyIUKeW1HRkoWS9QXzPTnmWQvoOkQMED5Q8UDnDUE0ytLVv6jtbTyae6IP8T2qczNhKbAymLWP4nwXp94IhVDv9wWcGWoBRHHD/Fr8NPn6/Q8lpFpqCKwEgCGLsjF+4umOs3nZJeS8Y8ilrSHV0kazPqq6J5BRQylsgR4z2rALXhmWWkt8CAZvES49/aYDTZXsDxRzksnaDcTqAnz5DLtkqPux8c4LuPDTjfE9rnq0ziFUpotJfH4WFdjthUSbOjMdjFSXCtWg0EyyC9DU+fWcNq6UaDMq7tExJn6fFt3J+vKmPkZog9p4wqhoc6Dwvf8vjOfw9w+RcXucNj7e+0kpPa4wZmHDg1sHK5FAVCBXRgndb8XB2boj4TmBkgW9+AsLIOr/X6m/TX1uxjiyz3AOvjNQODMcVqb1GKrtrQ83qRQoCEf+SpITbeQJsSrLcnbhOR2zVZnBU0pXc46ghRAI+phMzGf3NnjRYBLOEPK8DzOxMheqcqFF5DIF+dyRZIYkhEgpJiNmn7wGIokhlLXWzNlEeHKvyTm4f4o+sWsdgNWHuUx2RHlG2KYDfniSaGyIUMMb4Zz/k+F5pGpyKp263x6v9VaBOztNyv40RmqGsG3o30+SMQZvXBAQsdb/UaJVTRdaVHZ2sPY22HzS9WuPDaLnbuqnHWySUe+vIU/uCjbcxRIUPpylKfeQMjuLTHF+drHH9sC2tWlxxGRKJiFADY/nKFXTsqjLUpE2jsx3Qq6C8A6CQEuP2V1wCNNfpmamvG/wg6amzLOmESPh+D0P7FVwMuuHoRW7dXOP19JW79zDjaLWBqQsLGipXo9jpZa2tTuG742EQmtKZSpcU/+VEf3fmANhVDbHnJGpEa8zUnxVK+o8N4fFx/H2F/MSXl3VvrBzhqUUmIJHdNedyAcfvrARdc08WzL9U4+bgSt181jjEFP1tljiVsrOHFAzothz27a5xx6jhOfn8HVUVU12YkvUR6/c/DPXQKEi4VPkyIuDrMiqNA3pbz/tGV29j3N68QetLweWuKKEOjdjMpsMX8Sb6nt2VLgCd/VuHMK4Z44ZUK7z26wJ1Xj2N6ynGKHOvYjhR6XumrKpFkbBfAnjcrrD2mhc9dORXpb5wJhULh8dzPB9j0wwEmlxDZMM9JyC9VoGQmz7wgU0Bc089dfqRCPKApqqsutCRGrarTf8PhjT0Bu2cDdu8L2LOvxu69AbP7A3a8UeEXWyu86zCPr187jjWHNFtclvqoFUZkiRRKf6/fDdj1eoXf/PUObrtlBstnpIVH1aB5IydBB3zr6wvodym/Sy9AKG8qi1NPgOixk7XBfJ0ub2o2lJBVdY2YsK6MFiWfO9/jnSuBHz1HHuGFSmuKC5XH6uUOHz+jhdUrndQChSiBXtTEoLRHQFj1a47bibbDrxxR4twzx7Bh/QTKlvCHKLzyf+oSbX66j0f/vYtlU1K/MAFSdyceEIVXAxdxeVy5fwPtRxHd9vw0GqBqIn4zWhpw4akeF5769gmDeADFr1mOXq/urHkN8Nyzx3DGKR20yoBDVhQ4+siSFUVWr014fZCUTue9bsCXrtsfOQIxWxNamiAKiOwZojxPHmBr75a/Y2hpP988pMEHYsfT1u0TEaFTyvMCS9m9htTWpIwlMMWuw8JizV3do99Z4PNXTnHLK9UXQemz4/rBhmW84naYw99fuw/PbR5g5XTBniwIT9bWuHcS+8YraAAfGyIZBlgGyHd45fv4UsTZW+rGmB7KghoVQkqK/J1XeEiIlLRJWRQ+DzzSx8+2DHHqB9osfK9Xs9DkKZRdpAucApDcXsb2uOX6WTz0r4tYQcIPc0HT59QBSpmgsBCILa98BSfb0jKa7jMAOEhTJOmGU2C85BCoINEvyT9IwHbL49WdFW68bZ6Xu9afPcZ3m+KUPFiASQiQkkuP/ftr3PS3s3j4/i73Aql+sc4vC6+rQIL2Qs+NY6QQqG0zZEZYLC2mYowfokVN1n6dGg/NV8YPzF1iBORlFK36BLS956XuP/3sPjy7ZYDL/2QJjv3VEr2+FDK8yKrZIa0byvS//0gPt39pDttfqHiVF4NEm2PDU0tgvpZ7AdMXMUZpW1Kb+4GaqY8+twpgx96A+x4PuPjDsmB54GukX3DQl1yfXwDuf7SHm766gJdfGeIPf38c11wxxd91aO/BQV673qjw1BMDPPhvi3j6yT7GSoeZZbKIa2UyNb3yJqitBebub6tPnosj22010rsf3exEgDNRAld9o8aPX3B412rdB2xgl1Hf0CiEMseoA3r9gG3bK/xw0wAvbB1iqkMkyeOw1QW+9s0FDAeCFeIwAYNewK5dNV7ZWmHb80O8uaNmUrR0Uqo6WgITmptITlRAg1LnZMiIEODec8MwkDV4707+A4isCHJD2cNr3GDfHLi/Z3v4448Xsj38EiepEOLqTru8RaDdHeDtLrZldn6/LnHbhLlNpwQmAB3vMNFxGOPtNZrmaqvzpbYXzm/ARyWvl4YIdYbU/Rn4CFMqYGq5ly0yVqUdUMnZ6q4Bl94zM2E9xGztTxc045aavK1Of1wxxQWiqDULYJuj6G/QEje7byAl6IT1YAF0H7HsKpUmjVV4eakcra6rwlIP6DJYtkbA6Ri8P0CB1jYv5u2lvBoULsfnnJpG9vCyIEqWZHeJrjJn48adGrzzSyZgGxek2ySeZqFjz3FjNd/vo0JKw8QEVgVqt0iKH1sDlBTKy+r6TLBx6nwFuPGefpMTc79Z3RRkPXw+H21njVSPcQ9fanXbWLymb/1/29RgkKmNTRuLBVXrxx0m+lkENmVY7S/zEWtrb9BWiRxlgZGCJ+a9PLHlfEDBTP2hsTFRdpVJNWdPx21qWVPDWtP5ik+j4Zn176wFzoWN9fcyoDNhI+dXppkA0XoCTQLEPCAIdhxk5Tur+nWPsChKYzxH97h/37aqm+z2Sw7ZvGRa5x5c3IuUlBBbVBYWBlymuEx4Gyuv74X4pDTXYILWD8ja4zRKYVR49Fcdxg3invt8yUsVJCRPHshrBWNZ+R49UYLt5tYfRcR6Xy0c3Ta5dJ6/Zd/vCNjlxCcueCa2l1pgGQDGzpIVSEPMyq6w5q+wzOoNUIzu0uz0SFhkHlHTiq4InO4zr9ENSjHO841N2e5ui3PrBTZQPFlagC0Jb54Vd4pZqNiOttgPoI4AZn1ZYLPzLoQatS2CNmod3T3W7Asc+Puc5D1JKRbpRJnFYgZAI9iQub7EvY9gxc9yW1vW+HgME3KkwSkNDs0EVnXqWqARIG3X1y3XDq0xbPbTS4q7vVcCN7qwGWM73/HV3P0t7iwImoOhlMZpe0rc8q7tblaE9vxzJaTCJa3nC/iZp6QFTgNGi/0mC9TvOTukUNLUG8Y6hZte7e/2l52Iu8ar6qXalR6hrhq5P0+LI7/DaYBgrHnMve1HEhYu6RkWgq2bvKDJ3cVGOfhZLOdYkaq8xPIYX2zVV72uyPBEN01XnTDuy2WLL33w+rG7/PpT3NyvrQ4bx9tww8qT1ejHNHFPQEJ6Ke0E1LJd2FmhR90g04xpP+tfKCjmYKaWIU/ImhcpTpXi2q7UfLeH9fXVqSVsTNiMD+Rh4uraDT2mlpXu8BNaG1etcnN+3T2huPcvWg8dubS6dHJJUfD6bFVXrq5rrw3+tCaXOuGmBENzAzHpu0tvL63uNj8bykdeoCkt8QHL+SqAkRxz60wJcQ9BFh6p7CX8CYEQLtShKocTfmbpRLHs3d1LT7u+9dA99tNZ+yHxBTcNztz0mr9x74I/hnZXhD7F/PCAn6bJz+U0vrPr7K5VJUJZf5/v040NDcG02LGGJVmfOsuxdifg03U9vUZHrPz0fl7p5caGjNkiEmTFUXBooUDbjWGs5TE+Pdyy6vjqijO+MPYACb+efjwdiYsqIewMk+d8tbro1b1uXXehPrYahmn+hZmGgtefqsalNFvU1BpAhM8QXhUlCmgCmihAUnBUQixk6J2eSYqwvM9Iz5sfrApM7LDF7W651oILbef3Tky0Nk2vcfeed0dxp3Nu7h6EYr2sgOL/Aa5OuMdnE5sWAAAAAElFTkSuQmCC";
    var SETTINGS_CSS = ".dsm-model-settings{display:flex;flex-direction:column;gap:14px;margin:0;padding:0}.dsm-model-settings-list{display:flex;flex-direction:column;gap:10px}.dsm-model-settings-route{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr) minmax(0,1fr) auto;gap:8px;align-items:end;padding:10px;border:1px solid var(--dsw-alias-border-l2,#36373b);border-radius:10px;background:var(--dsw-alias-bg-layer-3,#202126)}.dsm-model-settings-field{display:flex;flex-direction:column;gap:4px;min-width:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,#b8b8b8)}.dsm-model-settings-select{width:100%;max-width:220px;height:32px;padding:0 28px 0 10px;border:1px solid var(--dsw-alias-border-l2,#36373b);border-radius:8px;background:var(--dsw-alias-bg-layer-2,#232529);color:var(--dsw-alias-label-primary,#e6e6e6);font:inherit;font-size:13px;line-height:1.5}.dsm-model-settings-select:focus{outline:2px solid var(--dsw-alias-state-business-primary,#5686fe);outline-offset:1px}.dsm-model-settings-select:disabled{color:var(--dsw-alias-label-tertiary,#999);cursor:default}.dsm-model-settings-input{width:100%;max-width:220px;height:32px;padding:0 10px;border:1px solid var(--dsw-alias-border-l2,#36373b);border-radius:8px;background:var(--dsw-alias-bg-layer-2,#232529);color:var(--dsw-alias-label-primary,#e6e6e6);font:inherit;font-size:13px;line-height:1.5}.dsm-model-settings-input:focus{outline:2px solid var(--dsw-alias-state-business-primary,#5686fe);outline-offset:1px}.dsm-model-settings-input::placeholder{color:var(--dsw-alias-label-caption,#777)}.dsm-model-settings-remove{height:32px;min-width:32px;border:1px solid var(--dsw-alias-border-l2,#36373b);border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary,#b8b8b8);cursor:pointer;font-size:16px;line-height:1}.dsm-model-settings-remove:hover{color:var(--dsw-alias-state-error-primary,#ef4444);background:var(--dsw-alias-interactive-bg-hover-danger,rgba(242,90,90,.15))}.dsm-model-settings-options{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}.dsm-model-settings-strategy{display:flex;align-items:center;gap:8px;white-space:nowrap;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,#b8b8b8)}.dsm-model-settings-strategy .dsm-model-settings-select{max-width:150px}.dsm-model-settings-failover{display:flex;align-items:center;gap:6px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,#b8b8b8);cursor:pointer}.dsm-model-settings-failover input[type=checkbox]{cursor:pointer}.dsm-failover-hint{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,#999);white-space:nowrap}.dsm-model-settings-inject-route{display:flex;align-items:center;gap:6px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,#b8b8b8);cursor:pointer}.dsm-model-settings-inject-route input[type=checkbox]{cursor:pointer}.dsm-inject-route-hint{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,#999)}.dsm-model-settings-footer{border-top:1px solid var(--dsw-alias-border-l2,#36373b);display:flex;align-items:center;justify-content:flex-end;gap:8px;padding:12px 0 4px}.dsm-model-settings-footer-left{display:flex;align-items:center;gap:10px;flex:1;min-width:0}.dsm-model-settings-footer-status{flex:1;min-width:0;color:var(--dsw-alias-label-secondary,#b8b8b8);font-size:12px;line-height:1.5}.dsm-model-settings-footer-error{flex:1;min-width:0;color:var(--dsw-alias-label-error,#ef4444);font-size:12px;line-height:1.5}.dsm-btn{appearance:none;font:inherit;cursor:pointer;border:1px solid transparent;border-radius:8px;padding:5px 14px;font-size:13px;line-height:1.5}.dsm-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#5686fe);outline-offset:1px}.dsm-btn:disabled{opacity:.4;cursor:default}.dsm-btn-outline{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);background:transparent;font-weight:500}.dsm-btn-outline:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed);background:rgba(255,255,255,.04)}.dsm-btn-primary{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3)}.dsm-btn-primary:hover:not(:disabled){opacity:.9}.dsm-model-settings-hint{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,#b8b8b8)}.dsm-plugin-card{border:1px solid var(--dsw-alias-border-l2,#36373b);background:var(--dsw-alias-bg-layer-3,#202126);border-radius:12px;list-style:none;transition:border-color .16s,background .16s}.dsm-plugin-card:hover{border-color:var(--dsw-alias-label-dimmed,#777)}.dsm-plugin-card-open{background:var(--dsw-alias-bg-layer-2,#25262b);border-color:var(--dsw-alias-label-dimmed,#777)}.dsm-plugin-card-header{appearance:none;width:100%;font:inherit;color:inherit;text-align:left;cursor:pointer;background:transparent;border:0;border-radius:12px;align-items:center;gap:12px;padding:14px 16px;display:flex}.dsm-plugin-card-header:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#5686fe);outline-offset:-2px}.dsm-plugin-card-head{flex-direction:column;flex:1;gap:4px;min-width:0;display:flex}.dsm-plugin-card-title{color:var(--dsw-alias-label-primary,#e6e6e6);font-size:15px;font-weight:600;line-height:1.4}.dsm-plugin-card-description{color:var(--dsw-alias-label-tertiary,#999);font-size:13px;line-height:1.5}.dsm-plugin-card-chevron{color:var(--dsw-alias-label-tertiary,#999);flex:none;display:inline-flex;transition:transform .16s}.dsm-plugin-card-chevron-open{transform:rotate(180deg)}.dsm-plugin-card-caret{color:inherit;font-size:12px;line-height:1;display:inline-flex}.dsm-plugin-card-body{border-top:1px solid var(--dsw-alias-border-l2,#36373b);margin:0 16px;padding:0 0 8px}.dsm-plugin-card-body .dsm-model-settings{margin:0;padding:12px 0 0;background:transparent;border:0;border-radius:0}.dsm-plugin-card-body .dsm-model-settings-head{display:none}.dsm-plugin-card-icon{width:32px;height:32px;flex:none;border-radius:7px}.dsm-model-settings-cheer{display:inline-flex;align-items:center;gap:4px;flex:none;text-decoration:underline;text-underline-offset:2px;color:var(--dsw-alias-label-tertiary,#999);font-size:13px;line-height:1.5;transition:color .16s}.dsm-model-settings-cheer-star{font-size:12px;line-height:1;display:inline-flex}.dsm-model-settings-cheer:hover{color:var(--dsw-alias-label-primary,#e6e6e6)}.dsm-model-settings-cheer:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#5686fe);outline-offset:2px}.dsm-model-settings-warn{grid-column:1/-1;color:var(--dsw-alias-label-error,#ef4444);font-size:12px;line-height:18px}.dsm-model-settings-warn-list{display:flex;flex-direction:column;gap:4px;color:var(--dsw-alias-label-error,#ef4444);font-size:12px;line-height:18px}.dsm-notice-row{display:flex;flex-direction:column;gap:4px;margin:6px 0;font-size:12px}.dsm-notice-toggle{appearance:none;font:inherit;cursor:pointer;background:transparent;border:0;padding:2px 0;display:flex;align-items:center;gap:6px;color:var(--dsw-alias-label-tertiary,#9a9a9a);text-align:left;min-width:0}.dsm-notice-toggle:hover{color:var(--dsw-alias-label-secondary,#b8b8b8)}.dsm-notice-toggle:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#5686fe);outline-offset:1px;border-radius:3px}.dsm-notice-dot{flex:none;width:5px;height:5px;border-radius:50%;background:var(--dsw-alias-label-caption,#777)}.dsm-notice-label{flex:none;font-weight:500}.dsm-notice-summary{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary,#b8b8b8)}.dsm-notice-summary:before{content:'·';margin-right:6px;color:var(--dsw-alias-label-caption,#777)}.dsm-notice-body{margin:0;padding:8px 10px;border-left:2px solid var(--dsw-alias-border-l2,#36373b);background:var(--dsw-alias-bg-layer-1,#1b1b1d);color:var(--dsw-alias-label-secondary,#b8b8b8);font-size:12px;line-height:18px;white-space:pre-wrap;overflow-wrap:anywhere;max-height:420px;overflow:auto}.dsm-exempt-list{display:flex;flex-direction:column;gap:6px;margin:0 0 8px;padding:0;list-style:none}.dsm-exempt-row{display:flex;align-items:center;gap:10px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l2,#36373b);border-radius:8px;background:var(--dsw-alias-bg-layer-2,#232529)}.dsm-exempt-row-name{flex:none;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary,#e6e6e6)}.dsm-exempt-row-name:empty{display:none}.dsm-exempt-sentence{flex:1;min-width:0;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary,#b8b8b8);overflow-wrap:anywhere}.dsm-exempt-sentence strong{color:var(--dsw-alias-label-primary,#e6e6e6);font-weight:600}.dsm-exempt-prefix{display:inline-block;max-width:260px;overflow:hidden;text-overflow:ellipsis;vertical-align:baseline;padding:1px 6px;border-radius:4px;background:var(--dsw-alias-bg-layer-3,#202126);border:1px solid var(--dsw-alias-border-l2,#36373b);font-family:ui-monospace,SFMono-Regular,Consolas,Menlo,monospace;font-size:11px;color:var(--dsw-alias-label-primary,#e6e6e6);white-space:nowrap}.dsm-exempt-arrow{flex:none;color:var(--dsw-alias-label-caption,#777)}.dsm-exempt-actions{display:flex;gap:4px;flex:none}.dsm-exempt-editor{display:flex;flex-direction:column;gap:10px;padding:12px;margin:0 0 8px;border:1px solid var(--dsw-alias-state-business-primary,#5686fe);border-radius:10px;background:var(--dsw-alias-bg-layer-2,#232529)}.dsm-exempt-editor-grid{display:grid;grid-template-columns:auto minmax(120px,1.1fr) auto minmax(140px,1fr);gap:8px;align-items:center}.dsm-exempt-editor-grid .dsm-model-settings-select{max-width:none;height:30px}.dsm-exempt-editor-grid .dsm-model-settings-input{max-width:none;height:30px}.dsm-exempt-connective{font-size:12px;color:var(--dsw-alias-label-secondary,#b8b8b8);white-space:nowrap}.dsm-exempt-pin-toggle{display:flex;align-items:center;gap:6px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,#b8b8b8);cursor:pointer;width:fit-content}.dsm-exempt-pin-toggle input[type=checkbox]{cursor:pointer}.dsm-exempt-pin-row{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr) minmax(0,1fr);gap:8px}.dsm-exempt-empty{display:flex;flex-direction:column;align-items:center;gap:10px;padding:16px 12px;margin:0 0 8px;border:1px dashed var(--dsw-alias-border-l2,#36373b);border-radius:8px;text-align:center;color:var(--dsw-alias-label-tertiary,#999);font-size:12px;line-height:18px}.dsm-exempt-editor-footer{display:flex;align-items:center;justify-content:flex-end;gap:8px}.dsm-exempt-editor-error{flex:1;min-width:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-error,#ef4444)}.dsm-model-settings-remove.dsm-exempt-armed{min-width:0;padding:0 10px;font-size:12px;color:#fff;background:var(--dsw-alias-state-error-primary,#ef4444);border-color:transparent}";

    // ── live route picker（子代理运行中换模型）───────────────────────────
    //
    // 与设置卡分开的一份样式：这套控件渲染在**对话头部**（子代理窗口），
    // 不在设置页里，所以不能复用 `.dsm-plugin-card*` 那套卡片骨架。
    // 配色沿用宿主的 `--dsw-alias-*` 变量，跟随主题。
    var PICKER_CSS = ".dsm-live-route{display:inline-flex;align-items:center;gap:6px;min-width:0}.dsm-live-route-reset{height:26px;min-width:26px;padding:0 6px;border:1px solid var(--dsw-alias-border-l2,#36373b);border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary,#b8b8b8);cursor:pointer;font:inherit;font-size:12px;line-height:1}.dsm-live-route-reset:hover{color:var(--dsw-alias-label-primary,#e6e6e6);background:rgba(255,255,255,.05)}.dsm-live-route-busy{opacity:.55}.dsm-live-route-note{font-size:11px;line-height:1.3;color:var(--dsw-alias-label-tertiary,#999);white-space:nowrap}.dsm-live-route-error{font-size:11px;line-height:1.3;color:var(--dsw-alias-label-error,#ef4444);white-space:nowrap}";

    var LIVE_MENU_CSS = ".dsm-live-route{position:relative}.dsm-live-route-trigger{display:inline-flex;align-items:center;gap:5px;max-width:240px;border:none;background:none;color:var(--dsw-alias-label-tertiary,#999);font:inherit;font-size:13px;line-height:20px;cursor:pointer;padding:1px 8px;border-radius:var(--dsw-radius-sm,6px);white-space:nowrap}.dsm-live-route-trigger:hover,.dsm-live-route-trigger[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.06));color:var(--dsw-alias-label-secondary,#b8b8b8)}.dsm-live-route-trigger[disabled]{opacity:.55;cursor:default}.dsm-live-route-trigger-model{overflow:hidden;text-overflow:ellipsis}.dsm-live-route-trigger-effort{color:var(--dsw-alias-label-tertiary,#999)}.dsm-live-route-caret{font-size:10px;transform:translateY(1px)}.dsm-live-route-caret svg{width:12px;height:12px;display:block}.dsm-live-route-panel{box-sizing:border-box;display:flex;flex-direction:column;padding:8px;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary,#b8b8b8);overflow:hidden}.dsm-live-route-list{min-height:0;overflow-y:auto}.dsm-live-route-footer{flex:none}.dsm-live-route-panel-up,.dsm-live-route-panel-down{position:absolute;right:0;z-index:1200;width:min(280px,86vw);max-height:min(360px,60vh);border-radius:10px;background:var(--dsw-specific-menu,#1e1f22);box-shadow:0 8px 28px rgba(0,0,0,.35),0 0 0 .5px var(--dsw-alias-border-l2,#36373b)}.dsm-live-route-panel-up{bottom:calc(100% + 8px)}.dsm-live-route-panel-down{top:calc(100% + 8px)}.dsm-live-route-panel-fixed{border-radius:10px;background:var(--dsw-specific-menu,#1e1f22);box-shadow:0 8px 28px rgba(0,0,0,.35),0 0 0 .5px var(--dsw-alias-border-l2,#36373b)}.dsm-live-route-group{margin:2px 0 6px}.dsm-live-route-group-label{font-size:11px;color:var(--dsw-alias-label-tertiary,#8a8a8a);padding:4px 8px 2px}.dsm-live-route-item{display:flex;width:100%;align-items:center;gap:6px;border:none;background:none;color:inherit;font:inherit;font-size:12px;padding:5px 8px;border-radius:6px;cursor:pointer;text-align:left;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.dsm-live-route-item:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.06))}.dsm-live-route-item-on{color:var(--dsw-alias-label-primary,#e6e6e6)}.dsm-live-route-check{width:14px;flex:none}.dsm-live-route-efforts{display:flex;flex-wrap:wrap;align-items:center;gap:4px;padding:6px 8px 2px;border-top:.5px solid var(--dsw-alias-border-l2,#36373b);margin-top:6px}.dsm-live-route-efforts-label{font-size:11px;color:var(--dsw-alias-label-tertiary,#8a8a8a);margin-right:2px}.dsm-live-route-chip{border:.5px solid var(--dsw-alias-border-l2,#36373b);background:none;color:inherit;font:inherit;font-size:11px;padding:2px 8px;border-radius:999px;cursor:pointer}.dsm-live-route-chip:hover{color:var(--dsw-alias-label-primary,#e6e6e6)}.dsm-live-route-chip-on{color:var(--dsw-alias-label-primary,#e6e6e6);border-color:var(--dsw-alias-state-business-primary,#5686fe)}"
      // Fallback styles for the picker's own dsm-live-route-* classes. They
      // mirror the claude-style theme's metrics so the control looks native
      // with no theme at all; these are the ONLY rules that style it now —
      // the theme manages its own dsh-claude-model-* names and must never
      // see ours (its DOM sweeps delete unknown elements carrying its names).
      + ".dsm-live-route-seat{display:inline-flex;align-items:center;gap:4px;min-width:0;height:28px;padding:0 4px 0 8px;border:none;border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary,#b8b8b8);font:inherit;font-size:13px;line-height:20px;cursor:pointer}.dsm-live-route-seat:hover,.dsm-live-route-seat[aria-expanded=true]{background:rgba(255,255,255,.06);color:var(--dsw-alias-label-primary,#e6e6e6)}.dsm-live-route-seat[disabled]{opacity:.55;cursor:default}"
      + ".dsm-live-route-btn{display:inline-flex;align-items:center;gap:4px;min-width:0;max-width:280px;border:none;background:transparent;color:inherit;font:inherit;white-space:nowrap;cursor:pointer;padding:0}.dsm-live-route-btn-label{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:left}"
      + ".dsm-live-route-tag{flex:none;padding:0 5px;border-radius:4px;background:var(--dsw-alias-state-business-tertiary,rgba(86,134,254,.16));color:var(--dsw-alias-state-business-primary,#5686fe);font:inherit;font-size:10px;font-weight:500;line-height:16px}"
      + ".dsm-live-route-group-section{margin:2px 0 4px}.dsm-live-route-group-name{padding:4px 8px 2px;color:var(--dsw-alias-label-tertiary,#8a8a8a);font-size:11px;line-height:16px}"
      + ".dsm-live-route-option{display:flex;width:100%;align-items:center;gap:8px;min-height:27px;padding:1px 7px;border:none;border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary,#e6e6e6);font:inherit;font-size:13px;text-align:left;cursor:pointer;box-sizing:border-box}.dsm-live-route-option:hover{background:rgba(255,255,255,.06)}.dsm-live-route-option[disabled]{opacity:.55;cursor:default}.dsm-live-route-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}"
      + ".dsm-live-route-divider{height:0.5px;margin:4px 0;border:none;background:var(--dsw-alias-border-l2,rgba(255,255,255,.14))}"
      // While this plugin's picker is mounted (subagent conversations only) it
      // is the ONE model control on the page. The host's own seat does not
      // render for child sessions at all, and a theme that draws a seat of its
      // own would otherwise duplicate the control — or, worse, swallow the
      // click. Both are suppressed here rather than by hiding the picker: the
      // user must always end up with exactly one working control.
      //
      // Scoped to the marked CONTAINER, never to `body`: a subagent pane can be
      // open next to its parent conversation, and a document-wide rule would
      // also strip the parent's perfectly good seat. The attribute lands on the
      // nearest composer card (falling back to body when there is none).
      + "[data-dsm-live-route] .dsh-claude-model-seat,[data-dsm-live-route] .dsh-claude-model-popover,[data-dsm-live-route] .dsh-claude-effort-popover,[data-dsm-live-route] [data-slot='conversation.input.model']{display:none!important}";

    // Header critters: one pixel-art workstation per running subagent. The
    // root is pinned to the right end of the conversation title row (the row
    // carrying the session badges): it renders into the header.actions slot
    // but escapes the flex flow with fixed positioning once the anchor
    // effect below has MEASURED that row — right/top are written as inline
    // styles from the row's live box, never hard-coded, so host chrome that
    // grows (e.g. a tab bar) cannot park the critters in dead space again.
    // Before a measurement lands the root stays position:relative in normal
    // flow, i.e. exactly where the header actions row puts it.
    // 六个角色的造型只有这一份数据：32×24 画布、2px 一格，部件写成
    // [类名, x, y, w, h]，类名拼成 .dsm-critter-<角色>-<部件>。渲染和配色都
    // 从这里走 —— 颜色只按部件语义取（身体/暗部/墨色/工具/中灰/火花/木箱），
    // 所以六个角色是一家人，改一处不会只改到一半。spare 里是整体旋转的部件。
    var CRITTER_KINDS = ["maker", "octo", "weld", "hamster", "owl", "courier"];
    var CRITTER_TONE = {
      ink: "#26211d", tool: "#4a4b50", mid: "#7c7d82",
      spark: "#ffe9a3", brown: "#a8814e", flip: "#9aa0a6"
    };
    var CRITTER_ART = {
      // 1. 敲键盘的小工匠：橙色团子伏在键盘上，头顶冒碎屑。
      maker: {
        body: "#e2694a", shade: "#c85337",
        parts: [
          ["crumb", 2, 6, 2, 2], ["crumb2", 28, 4, 2, 2], ["crumb3", 3, 11, 2, 2],
          ["body", 8, 4, 12, 4], ["body", 6, 8, 18, 6], ["body", 8, 14, 14, 4],
          ["shade", 8, 16, 14, 2],
          ["eye", 10, 5, 2, 3], ["eye", 16, 5, 2, 3],
          ["arm", 10, 18, 4, 2], ["arm2", 16, 18, 4, 2]
        ],
        ground: [
          ["board", 8, 20, 16, 3],
          ["key", 10, 21, 2, 1], ["key2", 14, 21, 2, 1], ["key3", 18, 21, 2, 1]
        ]
      },
      // 2. 章鱼多手：紫色方头，五条触手两弯三直，右边一块小屏。
      octo: {
        body: "#a06ce0", shade: "#8557bd",
        parts: [
          ["body", 10, 2, 12, 2], ["body", 8, 4, 16, 8], ["shade", 8, 10, 16, 2],
          ["eye", 12, 6, 2, 3], ["eye", 18, 6, 2, 3],
          ["tent", 8, 12, 2, 2], ["tent", 6, 14, 2, 2], ["tent", 6, 16, 2, 4], ["tentTip", 6, 20, 2, 2],
          ["tent2", 12, 12, 2, 4], ["tentTip2", 12, 16, 2, 2],
          ["tent", 16, 12, 2, 6], ["tentTip", 16, 18, 2, 2],
          ["tent3", 20, 12, 2, 2], ["tent3", 22, 14, 2, 4], ["tentTip3", 22, 18, 2, 2],
          ["tent3", 23, 14, 2, 2], ["tentTip3", 24, 16, 2, 2]
        ],
        ground: [
          ["screen", 25, 14, 7, 8],
          ["glow", 26, 16, 5, 2], ["glow2", 26, 19, 5, 2]
        ]
      },
      // 3. 焊接小机器人：青色方块，护目镜 + 天线，左手焊枪，枪尖冒黄火花。
      weld: {
        body: "#4fb3c4", shade: "#3f93a2",
        parts: [
          ["antenna", 15, 0, 2, 2],
          ["body", 12, 2, 8, 6],
          ["goggle", 11, 4, 10, 3], ["lens", 12, 5, 2, 2], ["lens2", 18, 5, 2, 2],
          ["body", 10, 8, 12, 8], ["shade", 10, 14, 12, 2],
          ["leg", 12, 16, 2, 4], ["leg2", 18, 16, 2, 4],
          ["arm", 6, 10, 4, 2], ["torch", 4, 10, 2, 5], ["tip", 4, 15, 2, 2],
          ["spark", 2, 16, 2, 2], ["spark2", 6, 16, 2, 2], ["spark3", 3, 19, 2, 2]
        ]
      },
      // 4. 跑轮仓鼠：八角滚轮里一只黄仓鼠，轮子整体转、腿交替。
      hamster: {
        body: "#e0b344", shade: "#bd9432",
        parts: [
          ["body", 10, 8, 12, 10], ["shade", 10, 16, 12, 2],
          ["ear", 10, 6, 2, 2], ["ear2", 20, 6, 2, 2],
          ["eye", 12, 10, 2, 3], ["eye", 18, 10, 2, 3],
          ["nose", 15, 13, 2, 2],
          ["leg", 11, 18, 2, 2], ["leg2", 19, 18, 2, 2],
          ["tail", 22, 13, 2, 3]
        ],
        ground: [
          ["ring", 10, 2, 12, 2],
          ["ring", 8, 4, 2, 2], ["ring", 22, 4, 2, 2],
          ["ring", 6, 6, 2, 12], ["ring", 24, 6, 2, 12],
          ["ring", 8, 18, 2, 2], ["ring", 22, 18, 2, 2],
          ["ring", 10, 20, 12, 2]
        ],
        spin: [
          ["spoke", 14, 4, 4, 2], ["spoke", 14, 18, 4, 2],
          ["spoke", 8, 10, 2, 4], ["spoke", 22, 10, 2, 4]
        ],
        groundSpin: true
      },
      // 5. 翻书猫头鹰：绿色尖耳，两片浅黄镜片，喙下面一本摊开的书。
      owl: {
        body: "#6fae5a", shade: "#578f47",
        parts: [
          ["ear", 8, 0, 2, 2], ["ear2", 22, 0, 2, 2],
          ["body", 8, 2, 16, 14], ["shade", 8, 14, 16, 2],
          ["wing", 6, 8, 2, 6], ["wing2", 24, 8, 2, 6],
          ["lens", 9, 5, 6, 6], ["lens2", 17, 5, 6, 6],
          ["eye", 11, 7, 2, 3], ["eye", 19, 7, 2, 3],
          ["beak", 15, 11, 2, 2],
          ["book", 5, 16, 10, 6], ["book", 17, 16, 10, 6],
          ["spine", 15, 16, 2, 6],
          ["page", 6, 17, 8, 4], ["page2", 18, 17, 8, 4],
          ["flip", 17, 16, 2, 4]
        ]
      },
      // 6. 送包裹的快递员：蓝衣戴帽，两只手抱着木箱，脚下一条传送带。
      courier: {
        body: "#5b8dd6", shade: "#4872ad",
        parts: [
                    ["body", 12, 9, 8, 6], ["shade", 12, 13, 8, 2],
          ["cap", 12, 1, 8, 2], ["brim", 10, 3, 12, 2],
          ["body", 13, 5, 6, 4],
          ["eye", 14, 6, 2, 2], ["eye", 17, 6, 2, 2],
          ["parcel", 10, 11, 12, 7], ["strap", 15, 11, 2, 7],
          ["arm", 9, 12, 2, 3], ["arm2", 21, 12, 2, 3],
          ["leg", 13, 18, 2, 3], ["leg2", 17, 18, 2, 3]
        ],
        ground: [
          ["belt", 2, 21, 28, 2]
        ]
      }
    };

    /** 部件语义 -> 颜色。没写进表里的部件用主色兜底。 */
    function critterToneOf(kind, cls) {
      var art = CRITTER_ART[kind] || CRITTER_ART.maker;
      if (cls === "body" || cls === "arm" || cls === "arm2" || cls === "tent" || cls === "tent2" || cls === "tent3") return art.body;
      if (cls === "shade" || cls === "ear" || cls === "ear2" || cls === "tail" || cls === "leg" || cls === "leg2" || cls === "wing" || cls === "wing2" || cls === "cap" || cls === "tentTip" || cls === "tentTip2" || cls === "tentTip3") return art.shade;
      if (cls === "eye" || cls === "nose") return CRITTER_TONE.ink;
      if (cls === "key" || cls === "key2" || cls === "key3" || cls === "spoke" || cls === "page" || cls === "page2" || cls === "glow" || cls === "glow2") return CRITTER_TONE.mid;
      if (cls === "tip" || cls === "spark" || cls === "spark2" || cls === "spark3" || cls === "lens" || cls === "lens2" || cls === "antenna") return CRITTER_TONE.spark;
      if (cls === "parcel" || cls === "box") return CRITTER_TONE.brown;
      if (cls === "flip") return CRITTER_TONE.flip;
      if (cls === "crumb" || cls === "crumb2" || cls === "crumb3") return art.body;
      return CRITTER_TONE.tool;
    }

    var CRITTERS_CSS = ""
      + ".dsm-critters{position:relative;z-index:20!important;display:inline-flex;align-items:flex-start;height:auto;min-height:24px}"
      + ".dsm-critters.is-anchored{position:fixed!important}"
      + ".dsm-critters-btn{display:inline-flex;align-items:flex-start;gap:2px;height:auto;padding:0 4px;border:none;border-radius:6px;background:transparent;color:inherit;font:inherit}"
      + ".dsm-critters-station{display:inline-flex;flex-direction:column;align-items:center;gap:1px;height:auto;padding:1px 2px;border:none;border-radius:6px;background:transparent;color:inherit;font:inherit;cursor:pointer;animation:dsm-critters-pop .28s steps(4) both}"
      + ".dsm-critters-station:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.06))}"
      + ".dsm-critters-station:focus-visible{outline:2px solid var(--dsw-alias-accent,#4c8dff);outline-offset:0}"
      + ".dsm-critters-art{display:block;width:32px;height:24px;overflow:visible;shape-rendering:crispEdges}"
      + ".dsm-critters-tag{max-width:76px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:9px;line-height:12px;color:var(--dsw-alias-label-tertiary,#8a8f98);pointer-events:none}"
      + ".dsm-critters-more{align-self:center;padding:0 2px;border:none;border-radius:6px;background:transparent;font-size:10px;line-height:14px;color:var(--dsw-alias-label-tertiary,#999);font:inherit;cursor:pointer}"
      + ".dsm-critters-back{align-self:center;margin-right:4px;padding:1px 6px;border:none;border-radius:6px;background:transparent;font-size:10px;line-height:14px;color:var(--dsw-alias-label-tertiary,#8a8f98);font:inherit;cursor:pointer}"
      + ".dsm-critters-back:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.06));color:var(--dsw-alias-label-secondary,#b8b8b8)}"
      + ".dsm-critters-panel{position:fixed;right:12px;top:64px;z-index:1200;width:max-content;max-width:min(320px,86vw);max-height:min(60vh,420px);overflow-y:auto;overscroll-behavior:contain;padding:8px;border-radius:10px;background:var(--dsw-specific-menu,#1e1f22);box-shadow:0 8px 28px rgba(0,0,0,.35),0 0 0 .5px var(--dsw-alias-border-l2,#36373b);font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary,#b8b8b8)}"
      + ".dsm-critters-panel-title{padding:2px 6px 6px;font-size:11px;color:var(--dsw-alias-label-tertiary,#8a8a8a)}"
      + ".dsm-critters-row{display:flex;align-items:baseline;gap:10px;padding:3px 6px;border-radius:6px;cursor:pointer}"
      + ".dsm-critters-row:hover{background:rgba(255,255,255,.05)}"
      + ".dsm-critters-row:focus-visible{outline:2px solid var(--dsw-alias-accent,#4c8dff);outline-offset:-2px}"
      + ".dsm-critters-row-name{flex:0 1 auto;min-width:3em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary,#e6e6e6)}"
      + ".dsm-critters-row-tokens{flex:none;text-align:right;font-size:11px;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-tertiary,#8a8a8a)}"
      + ".dsm-critters-row-age{flex:none;min-width:46px;text-align:right;font-size:11px;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-tertiary,#8a8a8a)}"
      + ".dsm-critters[data-anim-paused='1'] [class*='dsm-critter-']{animation-play-state:paused!important}"
      + ".dsm-critters-art.is-leaving{animation:dsm-critters-stretch .9s steps(6) forwards}"
      + "@keyframes dsm-critters-pop{from{opacity:0;transform:translateY(4px) scale(.85)}to{opacity:1;transform:none}}"
      + "@keyframes dsm-critters-stretch{0%{opacity:1;transform:none}45%{transform:translateY(-2px) scaleY(1.14)}100%{opacity:0;transform:translateY(-1px) scaleY(1.08)}}"

    // 配色与动作也从 CRITTER_ART 走：颜色按部件语义取，动作按角色配。位移
    // 一律整像素、只用 steps()，周期 0.4–2.4s；静止偏好统一关闭。
    var CRITTER_MOTION = {
      maker: {
        rig: "dsm-critter-hop .5s steps(1) infinite alternate",
        arm: "dsm-critter-type .34s steps(1) infinite alternate",
        arm2: "dsm-critter-type .34s steps(1) infinite alternate .17s",
        key: "dsm-critter-key .34s steps(1) infinite",
        key2: "dsm-critter-key .34s steps(1) infinite .11s",
        key3: "dsm-critter-key .34s steps(1) infinite .22s",
        crumb: "dsm-critter-crumb 1.8s steps(2) infinite",
        crumb2: "dsm-critter-crumb 1.8s steps(2) infinite .6s",
        crumb3: "dsm-critter-crumb 1.8s steps(2) infinite 1.2s",
        eye: "dsm-critter-blink 3.2s steps(1) infinite"
      },
      octo: {
        rig: "dsm-critter-float .6s steps(2) infinite alternate",
        tent: "dsm-critter-tap .38s steps(1) infinite alternate",
        tent2: "dsm-critter-tap .38s steps(1) infinite alternate .12s",
        tent3: "dsm-critter-tap .38s steps(1) infinite alternate .24s",
        glow: "dsm-critter-glow 1.2s steps(1) infinite",
        glow2: "dsm-critter-glow 1.2s steps(1) infinite .6s",
        eye: "dsm-critter-blink 4s steps(1) infinite"
      },
      weld: {
        rig: "dsm-critter-buzz .7s steps(1) infinite alternate",
        spark: "dsm-critter-spark .45s steps(1) infinite",
        spark2: "dsm-critter-spark .45s steps(1) infinite .15s",
        spark3: "dsm-critter-spark .45s steps(1) infinite .3s",
        tip: "dsm-critter-spark .45s steps(1) infinite",
        lens: "dsm-critter-glint 1.6s steps(1) infinite",
        lens2: "dsm-critter-glint 1.6s steps(1) infinite .8s"
      },
      hamster: {
        rig: "dsm-critter-bounce .3s steps(1) infinite alternate",
        spin: "dsm-critter-spin .45s steps(8) infinite",
        leg: "dsm-critter-bounce .3s steps(1) infinite alternate",
        leg2: "dsm-critter-bounce .3s steps(1) infinite alternate .15s",
        eye: "dsm-critter-blink 3.2s steps(1) infinite"
      },
      owl: {
        rig: "dsm-critter-nod .6s steps(2) infinite alternate",
        eye: "dsm-critter-scan 1.6s steps(1) infinite",
        flip: "dsm-critter-flip 1.2s steps(4) infinite",
        page: "dsm-critter-page 1.2s steps(1) infinite",
        page2: "dsm-critter-page 1.2s steps(1) infinite .6s"
      },
      courier: {
        rig: "dsm-critter-hop .5s steps(1) infinite alternate",
        leg: "dsm-critter-run .5s steps(1) infinite alternate",
        leg2: "dsm-critter-run .5s steps(1) infinite alternate .25s",
        parcel: "dsm-critter-haul .34s steps(1) infinite alternate",
        arm: "dsm-critter-haul .34s steps(1) infinite alternate",
        arm2: "dsm-critter-haul .34s steps(1) infinite alternate"
      }
    };

    /** 由 CRITTER_ART 生成六个角色的配色与动作规则（部件去重，顺序稳定）。 */
    function critterKindsCss() {
      var out = "";
      var motionClasses = [];
      for (var i = 0; i < CRITTER_KINDS.length; i++) {
        var kind = CRITTER_KINDS[i];
        var art = CRITTER_ART[kind];
        var seen = Object.create(null);
        var parts = art.parts.concat(art.ground || [], art.spin || []);
        for (var j = 0; j < parts.length; j++) {
          var cls = parts[j][0];
          if (seen[cls]) continue;
          seen[cls] = 1;
          out += ".dsm-critter-" + kind + "-" + cls + "{fill:" + critterToneOf(kind, cls) + "}";
        }
        var motion = CRITTER_MOTION[kind] || {};
        for (var key in motion) {
          if (!Object.prototype.hasOwnProperty.call(motion, key)) continue;
          out += ".dsm-critter-" + kind + "-" + key + "{animation:" + motion[key] + "}";
          motionClasses.push(".dsm-critter-" + kind + "-" + key);
        }
      }
      out += ".dsm-critter-hamster-spin{transform-box:fill-box;transform-origin:center}";
      out += "@keyframes dsm-critter-hop{from{transform:translateY(0)}to{transform:translateY(-4px)}}"
        + "@keyframes dsm-critter-float{from{transform:translateY(0)}to{transform:translateY(-4px)}}"
        + "@keyframes dsm-critter-bounce{from{transform:translateY(0)}to{transform:translateY(-3px)}}"
        + "@keyframes dsm-critter-buzz{0%,100%{transform:translateX(0)}50%{transform:translateX(2px)}}"
        + "@keyframes dsm-critter-nod{from{transform:translateY(0)}to{transform:translateY(-3px)}}"
        + "@keyframes dsm-critter-type{from{transform:translateY(0)}to{transform:translateY(-5px)}}"
        + "@keyframes dsm-critter-key{0%,100%{opacity:1}50%{opacity:.15}}"
        + "@keyframes dsm-critter-crumb{0%,100%{opacity:.9;transform:translateY(0)}50%{opacity:.1;transform:translateY(5px)}}"
        + "@keyframes dsm-critter-blink{0%,92%,100%{opacity:1}95%{opacity:0}}"
        + "@keyframes dsm-critter-tap{from{transform:translateY(0)}to{transform:translateY(5px)}}"
        + "@keyframes dsm-critter-glow{0%,45%,100%{opacity:1}50%,95%{opacity:.1}}"
        + "@keyframes dsm-critter-spark{0%,100%{opacity:0}40%,70%{opacity:1}}"
        + "@keyframes dsm-critter-glint{0%,80%,100%{opacity:1}85%,95%{opacity:.2}}"
        + "@keyframes dsm-critter-spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}"
        + "@keyframes dsm-critter-run{from{transform:translateY(0)}to{transform:translateY(-5px)}}"
        + "@keyframes dsm-critter-scan{0%,20%,100%{transform:translateX(0)}25%,55%{transform:translateX(-5px)}60%,95%{transform:translateX(5px)}}"
        + "@keyframes dsm-critter-flip{0%,100%{transform:translateX(0)}50%{transform:translateX(-12px)}}"
        + "@keyframes dsm-critter-page{0%,100%{opacity:1}50%{opacity:.4}}"
        + "@keyframes dsm-critter-bob{from{transform:translateY(0)}to{transform:translateY(-4px)}}"
        + "@keyframes dsm-critter-haul{from{transform:translateY(0)}to{transform:translateY(-4px)}}";
      out += "@media (prefers-reduced-motion: reduce){" + motionClasses.join(",") + "{animation:none!important}}";
      return out;
    }

    var CRITTERS_KINDS_CSS = critterKindsCss();

    // 批量切换卡：入口在输入框左侧行，卡片用 portal + fixed 脱离输入框的
    // transform/overflow 裁剪（和换模型选择器同一套路），向上展开。只保留
    // 模型 / 强度 / 应用三样，卡片底色先铺实色再叠主题渐变，避免透出对话。
    var BATCH_CSS = ".dsm-batch-entry{display:inline-flex;align-items:center;gap:4px;height:28px;padding:0 8px;border:none;border-radius:7px;background:transparent;color:var(--dsw-alias-label-tertiary,#999);font:inherit;font-size:13px;line-height:20px;cursor:pointer;white-space:nowrap}.dsm-batch-entry:hover,.dsm-batch-entry[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.06));color:var(--dsw-alias-label-primary,#e6e6e6)}.dsm-batch-entry-icon{font-size:14px;line-height:1;display:inline-flex}.dsm-batch-panel{position:fixed;z-index:1300;box-sizing:border-box;display:flex;flex-direction:column;gap:8px;padding:10px;border-radius:12px;background-color:#1e1f22;background-image:linear-gradient(var(--dsw-specific-menu,transparent),var(--dsw-specific-menu,transparent));box-shadow:0 12px 32px rgba(0,0,0,.4),0 0 0 .5px var(--dsw-alias-border-l2,#36373b);color:var(--dsw-alias-label-primary,#e6e6e6);font-size:12px;line-height:1.5;overflow:hidden}.dsm-batch-head{display:flex;align-items:center;gap:8px}.dsm-batch-title{flex:1;min-width:0;font-size:13px;font-weight:600;line-height:20px}.dsm-batch-icon-btn{width:24px;height:24px;display:inline-flex;align-items:center;justify-content:center;border:none;border-radius:6px;background:transparent;color:var(--dsw-alias-label-tertiary,#999);font:inherit;font-size:14px;line-height:1;cursor:pointer}.dsm-batch-icon-btn:hover{background:rgba(255,255,255,.06);color:var(--dsw-alias-label-primary,#e6e6e6)}.dsm-batch-field{display:flex;align-items:center;gap:6px;min-width:0}.dsm-batch-field-label{flex:none;width:34px;font-size:11px;color:var(--dsw-alias-label-tertiary,#999)}.dsm-batch-select{flex:1;min-width:0;height:28px;padding:0 6px;border:1px solid var(--dsw-alias-border-l2,#36373b);border-radius:7px;background:var(--dsw-alias-bg-layer-2,#232529);color:var(--dsw-alias-label-primary,#e6e6e6);font:inherit;font-size:12px}.dsm-batch-select:disabled{color:var(--dsw-alias-label-tertiary,#999);cursor:default}.dsm-batch-hint{color:var(--dsw-alias-label-tertiary,#8a8a8a);font-size:11px;line-height:16px}.dsm-batch-apply{height:30px;border-radius:8px;font-size:12px}.dsm-batch-status{color:var(--dsw-alias-label-secondary,#b8b8b8);font-size:11px;line-height:15px;overflow-wrap:anywhere}.dsm-batch-status-error{color:var(--dsw-alias-label-error,#ef4444)}.dsm-batch-status-ok{color:var(--dsw-alias-state-success-primary,#3fb950)}";


    if (typeof document !== "undefined") {
      var cssId = "dsh-subagent-role-router/client.css";
      if (!document.querySelector("style[data-plugin-css='" + cssId + "']")) {
        var styleTag = document.createElement("style");
        styleTag.dataset.plugin = "dsh-subagent-role-router";
        styleTag.dataset.pluginCss = cssId;
        styleTag.textContent = SETTINGS_CSS + PICKER_CSS + LIVE_MENU_CSS + BATCH_CSS + CRITTERS_CSS + CRITTERS_KINDS_CSS;
        document.head.appendChild(styleTag);
      }
    }

    // ── locale ───────────────────────────────────────────────────────────
    var SUBAGENT_ROW_LOCALE = "settings.subagentModel";

    // ── 对话流注入行的自有节点 kind（2026-09-25）─────────────────────────
    //
    // 宿主 0.1.7 起，插件注入消息在**对话流不可见**：`dsh-client-ui-chat` 的分类
    // 逻辑是 `if (event.data.source.kind !== "user") → kind: "context"`（与 form
    // 无关），而可见性规则 `isVisibleChatNode()` 硬排除 `node.kind !== "context"`
    // （注释明写「Exclude system prompts, ordinary Context, and permission
    // commands from visible Chat rows」）。故本插件的注入只进轨迹。
    //
    // 绕开方式是注册**自有节点 kind**：该可见性黑名单只列 system-prompt /
    // context / permission 三项，自定义 kind 默认可见；渲染器经
    // `conversation.chat.node` 槽位按 `entryKey = node.kind` 运行时分派。
    //
    // 注意：`source.kind`（消息来源标识，仍是 "plugin:dsh-subagent-role-router"）
    // 与这里的**节点 kind** 是两件事，不要混改。trajectory 侧不受此影响
    // （isVisibleChatNode 只在 ui-chat），故 trajectory definition 保持原样。
    var CHAT_MODEL_NODE_KIND = "chat-subagent-model-notice";
    var globalRouterNoticeEnabled = false;
    function isNoticeEnabled() {
      return globalRouterNoticeEnabled === true;
    }
    function updateNoticeEnabled(val) {
      if (typeof val === "boolean") {
        globalRouterNoticeEnabled = val;
      }
    }
    // Header critters switch. Module-level like the notice flag above, so the
    // settings card can flip it without a re-registration: the component reads
    // it on every poll tick and on every render, and hides itself (no fetch,
    // no DOM) the moment it is off. Default ON — the animation is the point of
    // the feature; the switch exists for users who want the header quiet.
    var globalCrittersEnabled = true;
    function isCrittersEnabled() {
      return globalCrittersEnabled !== false;
    }
    function updateCrittersEnabled(val) {
      if (typeof val === "boolean") {
        globalCrittersEnabled = val;
      }
    }
    var SUBAGENT_ROW_ZH = {
      "row.title": "子代理默认模型（dsh-subagent-role-router）",
      "row.desc": "为普通子任务（subagent / subagent_fork）指定默认模型池或分工角色；团队插件（如 agent-teams）自动豁免不受影响。",
      "row.provider": "Provider",
      "row.model": "Model",
      "row.effort": "推理强度",
      "row.add": "添加模型",
      "row.remove": "移除模型",
      "row.strategy": "默认池轮询策略",
      "row.roundRobin": "轮换",
      "row.random": "随机",
      "row.inherit": "（继承父会话路由）",
      "row.empty": "尚未指定默认模型，子代理将继承父会话路由。",
      "row.effortDefault": "Default",
      "row.discard": "放弃修改",
      "row.expand": "展开",
      "row.collapse": "收起",
      "row.cheer": "鼓励一下",
      "row.save": "保存",
      "row.saving": "保存中…",
      "row.saved": "已保存",
      "row.incomplete": "请为每个模型路由选择 Provider 和 Model。",
      "row.catalogEmpty": "模型目录尚未就绪（正在等待网关返回供应商与模型）。稍候片刻；若长时间为空，请检查 Provider 插件是否已启用。",
      "row.effortNoDeclaration": "该模型当前未声明任何推理强度；子代理会因 effort 不被支持而一个请求都发不出（清空此项或改选模型）。",
      "row.effortNotDeclared": "该模型当前未声明「{effort}」推理强度；子代理会因此无法启动（改选其它强度或清空此项）。",
      "row.saveFailed": "保存失败（{message}），请重试。",
      "row.settingsUnavailable": "本机宿主未为此插件提供设置存储（{message}），暂时无法保存；请确认插件已在当前 profile 中启用，然后重启 DSH。",
      "row.toastSaved": "子代理默认模型设置已保存。",
      "row.failoverEnabled": "连接失败时按队列与策略切换模型",
      "row.failoverHint": "（需配置 ≥2 个 Provider，切换才会生效）。",
      "row.injectRouteContext": "把当前模型与供应商写进子代理上下文",
      "row.injectRouteContextHint": "（子代理因此能回答自己跑在哪个模型上；这是一行真实提示词，不是界面显示）。",
      "row.showChatModelNotice": "在聊天界面显示子代理模型切换通知条",
      "row.showChatModelNoticeHint": "（默认关闭以保持聊天界面干净纯净；开启后在气泡上方展示“已切换到...”横条）。",
      "row.showHeaderCritters": "在对话标题行显示子代理小工匠动画",
      "row.showHeaderCrittersHint": "（默认开启；只显示当前会话里正在跑的子代理，空闲时完全不占位）。",
      "row.forkWindowSlicing": "启用 Fork 活跃窗口切片（针对旁问 BTW 和 subagent_fork）",
      "row.forkWindowSlicingHint": "（仅继承最近 N 轮已完成对话，彻底避免因全量历史与上万条工具日志引发超时或卡顿）。",
      "row.forkWindowTurns": "继承对话轮数",
      "row.forkWindowTurnsHint": "轮（推荐 3 轮，保障足够上下文且秒级响应）",
      "row.trajectoryModel": "当前供应商/模型",
      "row.chatModelInitial": "当前供应商/模型",
      "row.chatModelChange": "已切换到",
      "row.chatModelResume": "继续使用",
      "row.roleMode": "启用 3 角色智能分工（Explore 侦察 / Plan 架构 / General 通用执行）",
      "row.roleModeHint": "开启后，主 Agent 会按任务类型自动调用对应专家（探索与规划只读，通用角色负责改代码）；未开启时统一走下方默认模型池。",
      "row.roleExplore": "探索角色 (Explore / 侦察兵) - 只读调研与代码排查",
      "row.rolePlan": "规划角色 (Plan / 架构师) - 方案设计与任务拆解",
      "row.rolePatch": "通用执行角色 (General-purpose / 工匠) - 代码编写与全功能落地",
      "row.roleDescExplore": "只读安全模式（封锁 write / edit 工具）。专门负责快速搜索代码、排查定位报错，绝不改动代码。",
      "row.roleDescPlan": "只读安全模式（封锁 write / edit 工具）。专门负责分析系统架构、构思方案与分解任务，只出方案不改代码。",
      "row.roleDescPatch": "全功能读写权限（具备完整编辑能力）。负责落实方案、编写业务逻辑与代码改动。",
      "row.roleAddSlot": "＋ 增加候补",
      "row.roleRemoveSlot": "移除该候补",
      "row.roleSlotHint": "每行是一个候补；行数＝可同时干活的个数。按顺序优先使用靠前的候补，全部在忙时才让靠前的多担一个。",
      "row.cooldownSeconds": "调用失败后暂停使用该模型",
      "row.cooldownSecondsHint": "秒（默认 15 秒；填 0 表示不暂停，失败只顺延到下一个候补）",
      "row.teamModelTitle": "团队成员默认模型",
      "row.teamModelDesc": "新建团队成员出生时用这个模型（创建成员的接口本身没有选模型的地方，成员只会用系统给团队配的默认模型）。",
      "row.teamModelHint": "留空 = 用系统默认。成员出生后仍可在它自己的页面里随时切换模型。",
      "row.teamModelDefault": "（系统默认）",
      "row.exemptTitle": "插件豁免",
      "row.exemptDesc": "某些插件会为自己的目的派生固定的子代理。命中豁免规则的子代理：出生不注入默认模型、失败不自动切换；规则里选了模型则按该模型出生。",
      "row.exemptName": "备注",
      "row.exemptNamePh": "例如：EGM 金鱼评审",
      "row.exemptMatchLabel": "子代理标签",
      "row.exemptMatchPreset": "代理预设",
      "row.exemptMatchCwd": "工作目录",
      "row.exemptWhen": "当",
      "row.exemptPrefixIs": "前缀为",
      "row.exemptPick": "从观察记录点选",
      "row.exemptPickPh": "选择一个观察到的出生身份…",
      "row.exemptPrefixPh": "例如：egm-goldfish-",
      "row.exemptNoPin": "不干预模型",
      "row.exemptBirthUse": "出生用",
      "row.exemptPinToggle": "指定出生模型（可选）",
      "row.exemptPinTitle": "出生模型",
      "row.exemptBirth": "出生供应商",
      "row.exemptBirthDefault": "（不指定）",
      "row.exemptRuleSave": "保存规则",
      "row.exemptRuleCancel": "取消",
      "row.exemptEdit": "编辑规则",
      "row.exemptAdd": "添加豁免规则",
      "row.exemptEmpty": "还没有豁免规则。命中的插件子代理不会被注入默认模型，也不会被自动切换。",
      "row.exemptConfirm": "确认删除",
      "row.exemptRemove": "删除规则",
      "row.exemptEditorError": "还差一步：填匹配前缀；勾选了出生模型就要选到具体模型。",
      "row.exemptHint": "匹配为前缀精确匹配（区分大小写）；插件启动参数里显式指定的模型优先于这里。",
      "row.noticeLabel": "上下文注入 · dsh-subagent-role-router",
      "live.title": "换模型",
      "live.reset": "恢复默认",
      "live.resetTitle": "恢复为角色/默认池决定的路由",
      "live.pending": "下一步生效",
      "live.notLive": "该子代理已结束，无法再切换",
      "live.noCatalog": "模型目录尚未就绪",
      "live.failed": "切换失败：{message}",
      "live.pickOne": "选择模型…"
    };
    var SUBAGENT_ROW_EN = {
      "row.title": "Subagent default model (dsh-subagent-role-router)",
      "row.desc": "Choose one or more default routes for subagent / subagent_fork; clear them to inherit the parent session route.",
      "row.provider": "Provider",
      "row.model": "Model",
      "row.effort": "Reasoning strength",
      "row.add": "Add model",
      "row.remove": "Remove model",
      "row.strategy": "Distribution",
      "row.roundRobin": "Round-robin",
      "row.random": "Random",
      "row.inherit": "(inherit parent route)",
      "row.effortDefault": "Default",
      "row.empty": "No default model is selected; subagents inherit the parent route.",
      "row.discard": "Discard",
      "row.expand": "Expand",
      "row.collapse": "Collapse",
      "row.cheer": "Star on GitHub",
      "row.save": "Save",
      "row.saving": "Saving…",
      "row.saved": "Saved",
      "row.incomplete": "Choose a provider and model for every route.",
      "row.catalogEmpty": "The model catalog is not ready yet (waiting for the gateway to report providers and models). Give it a moment; if it stays empty, check whether the provider plugin is enabled.",
      "row.effortNoDeclaration": "This model declares no reasoning efforts right now; subagents will fail to issue any request with the configured effort (clear it or pick another model).",
      "row.effortNotDeclared": "This model does not declare the \"{effort}\" reasoning effort right now; subagents will fail to start (pick another effort or clear it).",
      "row.saveFailed": "Could not save the setting ({message}). Try again.",
      "row.settingsUnavailable": "This Host serves no settings store for the plugin ({message}), so saving is unavailable. Check that the plugin is enabled in the current profile, then restart DSH.",
      "row.toastSaved": "Subagent default model settings saved.",
      "row.failoverEnabled": "Switch models by queue and strategy on connection failure",
      "row.failoverHint": "(requires at least 2 configured providers).",
      "row.injectRouteContext": "Tell subagents which model and provider they run on",
      "row.injectRouteContextHint": "(so a subagent can answer which model it is; this is a real prompt line, not a display row).",
      "row.showChatModelNotice": "Show subagent model notice in chat view",
      "row.showChatModelNoticeHint": " (off by default to keep chat clean; enable to show 'Switched to...' notice row).",
      "row.showHeaderCritters": "Show the subagent critters animation in the header",
      "row.showHeaderCrittersHint": " (on by default; shows only subagents running in the current session, and takes no space when idle).",
      "row.forkWindowSlicing": "Enable Fork active window slicing (for BTW and subagent_fork)",
      "row.forkWindowSlicingHint": "(inherits only the most recent N turns of completed dialogue, preventing timeouts on massive logs).",
      "row.forkWindowTurns": "Window turns",
      "row.forkWindowTurnsHint": "turns (recommended 3 turns for instant response)",
      "row.trajectoryModel": "Current provider/model",
      "row.chatModelInitial": "Current provider/model",
      "row.chatModelChange": "Switched to",
      "row.chatModelResume": "Resumed on",
      "row.roleAddSlot": "＋ Add candidate",
      "row.roleRemoveSlot": "Remove this candidate",
      "row.roleSlotHint": "One row per candidate; the row count is how many can run at once. Earlier candidates are used first, and only take a second task when all of them are busy.",
      "row.cooldownSeconds": "Skip a model after a failed call for",
      "row.cooldownSecondsHint": "seconds (default 15; 0 disables the pause and only falls through to the next candidate)",
      "row.teamModelTitle": "Team member default model",
      "row.teamModelDesc": "New team members are born on this model (the spawn interface has no model picker, so members would otherwise use the system team default).",
      "row.teamModelHint": "Empty = system default. Members can still be switched to any model at any time from their own page after they start.",
      "row.teamModelDefault": "(system default)",
      "row.exemptTitle": "Plugin exemptions",
      "row.exemptDesc": "Some plugins spawn dedicated subagents for their own work. A child matching an exemption rule is born without the injected default model and is never auto-switched on failure; if the rule pins a model, the child is born on it.",
      "row.exemptName": "Note",
      "row.exemptNamePh": "e.g. EGM goldfish review",
      "row.exemptMatchLabel": "Subagent label",
      "row.exemptMatchPreset": "Agent preset",
      "row.exemptMatchCwd": "Working directory",
      "row.exemptWhen": "When",
      "row.exemptPrefixIs": "prefix is",
      "row.exemptPick": "Pick from observed plugins",
      "row.exemptPickPh": "Choose an observed birth identity…",
      "row.exemptPrefixPh": "e.g. egm-goldfish-",
      "row.exemptNoPin": "no model override",
      "row.exemptBirthUse": "born on",
      "row.exemptPinToggle": "Pin a birth model (optional)",
      "row.exemptPinTitle": "Birth model",
      "row.exemptBirth": "Birth provider",
      "row.exemptBirthDefault": "(unspecified)",
      "row.exemptRuleSave": "Save rule",
      "row.exemptRuleCancel": "Cancel",
      "row.exemptEdit": "Edit rule",
      "row.exemptAdd": "Add exemption rule",
      "row.exemptEmpty": "No exemption rules yet. Matching plugin children keep the system default and are never auto-switched.",
      "row.exemptConfirm": "Confirm delete",
      "row.exemptRemove": "Remove rule",
      "row.exemptEditorError": "Almost there: fill in the prefix; a pinned birth model needs a concrete model.",
      "row.exemptHint": "Matching is an exact, case-sensitive prefix. A model the plugin sets explicitly on its own spawn wins over the pin here.",
      "row.noticeLabel": "Context injection · dsh-subagent-role-router",
      "live.title": "Model",
      "live.reset": "Reset",
      "live.resetTitle": "Go back to the route the role/default pool decides",
      "live.pending": "applies next step",
      "live.notLive": "This subagent has finished; nothing to switch",
      "live.noCatalog": "The model catalog is not ready yet",
      "live.failed": "Could not switch: {message}",
      "live.pickOne": "Pick a model…"
    };

    // ── helpers ──────────────────────────────────────────────────────────
    // This plugin's DECLARED Loader entry id = `cordis.patch.yml` `insert.id`.
    // On 0.1.7 the settings namespace IS a Loader entry id, and the Desktop host
    // mounts community bundles as `include:<name>` — so the served name is
    // host-chosen and cannot be assumed here. `configForms.get()` matches the
    // served-namespace directory EXACTLY: binding a namespace nothing serves
    // fails silently (`status: unavailable`, no error, every write refused), so
    // the served name is probed from the describe mirror on every change instead
    // (see `servedNamespaceNow` in the `configForms` block).
    var SUBAGENT_MODEL_SETTINGS_NS = "dsh-subagent-role-router";

    
    function normalizeForkWindowTurns(val) {
      if (typeof val === "string") {
        var trimmed = val.trim();
        if (!/^\d+$/.test(trimmed)) return 3;
        val = Number(trimmed);
      }
      if (typeof val === "number" && Number.isSafeInteger(val) && val >= 1 && val <= 20) {
        return val;
      }
      return 3;
    }
    function normalizeDefaultModels(value) {
      var result = [];
      if (Array.isArray(value.models) && value.models.length > 0) {
        for (var i = 0; i < value.models.length; i++) {
          var entry = value.models[i];
          if (typeof entry === "string") result.push({ provider: value.provider || "", model: entry, reasoningEffort: "" });
          else if (entry && typeof entry === "object") result.push({ provider: entry.provider || value.provider || "", model: entry.model || "", reasoningEffort: entry.reasoningEffort || "" });
        }
      } else if (value.provider || value.model) {
        result.push({ provider: value.provider || "", model: value.model || "", reasoningEffort: value.reasoningEffort || "" });
      }
      return result;
    }

    // ── per-role candidate pools (spillover queues) ──────────────────────
    //
    // Each role owns an ORDERED list of candidate routes instead of one fixed
    // route. The list doubles as the capacity plan: its length is how many
    // concurrent "lanes" that role has, so adding a row is how a user says
    // "give the general role three lanes". An entirely blank row is a spare,
    // unused lane — it is dropped when saving and must never block Save.
    var ROLE_POOL_FIELDS = {
      explore: { pool: "exploreModels", provider: "exploreProvider", model: "exploreModel", effort: "exploreEffort" },
      plan: { pool: "planModels", provider: "planProvider", model: "planModel", effort: "planEffort" },
      patch: { pool: "patchModels", provider: "patchProvider", model: "patchModel", effort: "patchEffort" }
    };
    var ROLE_ORDER = ["explore", "plan", "patch"];

    function blankRoleRoute() {
      return { provider: "", model: "", reasoningEffort: "" };
    }

    /**
     * Read one role's candidate list out of a stored section.
     *
     * Precedence mirrors the plugin side: the `*Models` array first, then the
     * legacy single `*Provider`/`*Model`/`*Effort` triple. The result always
     * holds at least one row so the card has something to render — an empty
     * list would leave the role with no visible slot and no way to add one
     * without discovering the "add" button.
     */
    function normalizeRoleRoutes(value, role) {
      var fields = ROLE_POOL_FIELDS[role];
      // A missing section is the ordinary "nothing saved yet" case, not an
      // error: the card must still render one blank lane for the role.
      if (!value) value = {};
      var result = [];
      var declared = fields ? value[fields.pool] : void 0;
      if (Array.isArray(declared)) {
        for (var i = 0; i < declared.length; i++) {
          var entry = declared[i];
          if (typeof entry === "string") {
            result.push({ provider: value[fields.provider] || "", model: entry, reasoningEffort: "" });
          } else if (entry && typeof entry === "object") {
            result.push({
              provider: entry.provider || "",
              model: entry.model || "",
              reasoningEffort: entry.reasoningEffort || ""
            });
          }
        }
      }
      if (result.length === 0 && fields && (value[fields.provider] || value[fields.model])) {
        result.push({
          provider: value[fields.provider] || "",
          model: value[fields.model] || "",
          reasoningEffort: value[fields.effort] || ""
        });
      }
      return result.length > 0 ? result : [blankRoleRoute()];
    }

    /** Convert role rows into the stored pool shape, dropping blank spare lanes. */
    function serializeRolePool(routes) {
      var out = [];
      if (!Array.isArray(routes)) return out;
      for (var i = 0; i < routes.length; i++) {
        var route = routes[i];
        if (!route || !route.provider || !route.model) continue;
        var entry = { provider: route.provider, model: route.model };
        if (route.reasoningEffort) entry.reasoningEffort = route.reasoningEffort;
        out.push(entry);
      }
      return out;
    }

    /** A half-filled role row is invalid; a fully blank one is just an unused lane. */
    function roleRouteIncomplete(routes) {
      if (!Array.isArray(routes)) return false;
      for (var i = 0; i < routes.length; i++) {
        var route = routes[i];
        if (!route) continue;
        if ((route.provider && !route.model) || (!route.provider && route.model)) return true;
      }
      return false;
    }

    // ── plugin exemption rules ───────────────────────────────────────────
    //
    // One rule = 匹配方式 + 匹配值（前缀精确匹配）+ 可选出生模型。命中规则的
    // 插件子代理：出生不改模型（除非规则钉了模型）、报错不自动切换。pattern
    // 为空的规则永远匹配不上，保存时丢弃——它不是"空车道"，是无意义规则。
    function normalizeExemptRules(value) {
      var declared = value && Array.isArray(value.exemptRules) ? value.exemptRules : [];
      var result = [];
      for (var i = 0; i < declared.length; i++) {
        var entry = declared[i];
        if (!entry || typeof entry !== "object") continue;
        result.push({
          name: entry.name || "",
          match: entry.match === "preset" || entry.match === "cwd" ? entry.match : "label",
          pattern: entry.pattern || "",
          provider: entry.provider || "",
          model: entry.model || "",
          effort: entry.effort || ""
        });
      }
      return result;
    }

    /** Convert rule rows into the stored shape, dropping pattern-less rules. */
    function serializeExemptRules(rules) {
      var out = [];
      if (!Array.isArray(rules)) return out;
      for (var i = 0; i < rules.length; i++) {
        var rule = rules[i];
        // The backend trims before matching, so a whitespace-only pattern could
        // never match anything — it must not reach the stored document.
        var pattern = typeof rule?.pattern === "string" ? rule.pattern.trim() : "";
        if (!rule || !pattern) continue;
        var entry = {
          name: rule.name || "",
          match: rule.match === "preset" || rule.match === "cwd" ? rule.match : "label",
          pattern: pattern,
          provider: rule.provider || "",
          model: rule.model || "",
          effort: rule.effort || ""
        };
        if (!entry.model) { entry.provider = ""; entry.effort = ""; }
        if (entry.model && !entry.provider) continue;
        out.push(entry);
      }
      return out;
    }

    /** A half-pinned rule (provider without model, or the reverse) must block Save. */
    function exemptRuleIncomplete(rules) {
      if (!Array.isArray(rules)) return false;
      for (var i = 0; i < rules.length; i++) {
        var rule = rules[i];
        if (!rule) continue;
        if ((rule.provider && !rule.model) || (!rule.provider && rule.model)) return true;
      }
      return false;
    }

    function normalizeRoleCooldownSeconds(val) {
      if (typeof val === "string") {
        var trimmed = val.trim();
        if (!/^\d+$/.test(trimmed)) return 15;
        val = Number(trimmed);
      }
      if (typeof val === "number" && Number.isSafeInteger(val) && val >= 0 && val <= 3600) return val;
      return 15;
    }

    /**
     * Fingerprint of everything the card holds as "the form the user saved".
     *
     * The card keeps this on the SCOPE after a save so a describe mirror that
     * still serves the PREVIOUS document cannot overwrite the form (that is the
     * known "deleted rows come back" defect). It has to cover the role pools
     * too, not just the base routes: a mirror lag would otherwise resurrect the
     * old candidate list of every role.
     *
     * Pure and order-stable, so it doubles as an equality test.
     */
    function savedFormFingerprint(value) {
      return JSON.stringify({
        routes: normalizeDefaultModels(value || {}),
        explore: normalizeRoleRoutes(value || {}, "explore"),
        plan: normalizeRoleRoutes(value || {}, "plan"),
        patch: normalizeRoleRoutes(value || {}, "patch"),
        cooldown: normalizeRoleCooldownSeconds(value ? value.roleSlotCooldownSeconds : void 0),
        teamModel: {
          provider: (value && value.teamModelProvider) || "",
          model: (value && value.teamModelName) || "",
          effort: (value && value.teamModelEffort) || ""
        },
        exempt: normalizeExemptRules(value || {})
      });
    }

    /** Rebuild a section-shaped seed from a held fingerprint (never throws). */
    function seedFromSavedForm(held, fallback) {
      if (held === null || held === void 0) return fallback;
      try {
        var parsed = JSON.parse(held);
        var seed = Object.assign({}, fallback || {});
        // Older builds held a bare route array; accept that shape too.
        var routes = Array.isArray(parsed) ? parsed : parsed.routes;
        if (!Array.isArray(routes)) return fallback;
        seed.models = routes.map(function (route) {
          if (route.provider === (fallback && fallback.provider) && !route.reasoningEffort) return route.model;
          var entry = { provider: route.provider, model: route.model };
          if (route.reasoningEffort) entry.reasoningEffort = route.reasoningEffort;
          return entry;
        });
        var efforts = routes.map(function (route) { return route.reasoningEffort || ""; });
        if (routes.length > 0 && efforts.every(function (e) { return e === efforts[0] && e !== ""; })) {
          seed.reasoningEffort = efforts[0];
        } else if (routes.length === 0) {
          delete seed.reasoningEffort;
        }
        if (!Array.isArray(parsed)) {
          if (parsed.explore) seed.exploreModels = parsed.explore;
          if (parsed.plan) seed.planModels = parsed.plan;
          if (parsed.patch) seed.patchModels = parsed.patch;
          if (parsed.cooldown !== void 0) seed.roleSlotCooldownSeconds = parsed.cooldown;
          if (parsed.teamModel) {
            seed.teamModelProvider = parsed.teamModel.provider || "";
            seed.teamModelName = parsed.teamModel.model || "";
            seed.teamModelEffort = parsed.teamModel.effort || "";
          }
          if (parsed.exempt) seed.exemptRules = parsed.exempt;
        }
        return seed;
      } catch (_e) {
        return fallback;
      }
    }

    function serializeDefaultModels(previousValue, routes, strategy, failoverEnabled, injectRouteContext, roles, forkSettings, showChatModelNotice, showHeaderCritters) {
      var next = Object.assign({}, previousValue || {});
      next.failoverEnabled = failoverEnabled === false ? false : true;
      next.injectRouteContext = injectRouteContext === false ? false : true;
      next.showChatModelNotice = showChatModelNotice === true;
      next.showHeaderCritters = showHeaderCritters !== false;
      if (forkSettings) {
        next.forkWindowSlicing = forkSettings.forkWindowSlicing !== false;
        next.forkWindowTurns = normalizeForkWindowTurns(forkSettings.forkWindowTurns);
      }
      if (roles) {
        next.roleMode = roles.roleMode === true;
        next.exploreProvider = roles.exploreProvider || "";
        next.exploreModel = roles.exploreModel || "";
        next.exploreEffort = roles.exploreEffort || "";
        next.planProvider = roles.planProvider || "";
        next.planModel = roles.planModel || "";
        next.planEffort = roles.planEffort || "";
        next.patchProvider = roles.patchProvider || "";
        next.patchModel = roles.patchModel || "";
        next.patchEffort = roles.patchEffort || "";
        // The candidate pools are written alongside the legacy single values,
        // never instead of them: the single values keep an older build (or a
        // hand-edited config) reading the same role, and the pool is what the
        // new routing actually uses.
        if (roles.rolePools) {
          for (var roleIndex = 0; roleIndex < ROLE_ORDER.length; roleIndex++) {
            var role = ROLE_ORDER[roleIndex];
            var fields = ROLE_POOL_FIELDS[role];
            var pool = serializeRolePool(roles.rolePools[role]);
            next[fields.pool] = pool;
            // Keep the legacy triple in step with the FIRST lane so both
            // representations name the same primary route.
            var primary = pool[0];
            next[fields.provider] = primary ? primary.provider : "";
            next[fields.model] = primary ? primary.model : "";
            next[fields.effort] = primary && primary.reasoningEffort ? primary.reasoningEffort : "";
          }
        }
        if (roles.roleSlotCooldownSeconds !== void 0) {
          next.roleSlotCooldownSeconds = normalizeRoleCooldownSeconds(roles.roleSlotCooldownSeconds);
        }
        // Team birth model: written as-is; an empty provider or model means
        // "leave members on the team default" (teamBirthModel ignores halves).
        if (roles.teamModel !== void 0) {
          next.teamModelProvider = roles.teamModel.provider || "";
          next.teamModelName = roles.teamModel.model || "";
          next.teamModelEffort = roles.teamModel.effort || "";
        }
        // Plugin exemption rules: written as the stored rule list (pattern-less
        // rows dropped); an empty list means nothing is exempt.
        if (roles.exemptRules !== void 0) {
          next.exemptRules = serializeExemptRules(roles.exemptRules);
        }
      }
      if (routes.length === 0) {
        next.provider = "";
        next.model = "";
        next.models = [];
        next.strategy = "round-robin";
        delete next.reasoningEffort;
        return next;
      }
      var provider = routes[0].provider;
      var sharedEffort = routes[0].reasoningEffort;
      var allSameEffort = routes.every(function (route) { return route.reasoningEffort === sharedEffort; });
      next.provider = provider;
      next.model = "";
      next.models = routes.map(function (route) {
        if (route.provider === provider && !route.reasoningEffort) {
          return route.model;
        }
        var base = { provider: route.provider, model: route.model };
        if (route.reasoningEffort) {
          base.reasoningEffort = route.reasoningEffort;
        }
        return base;
      });
      next.strategy = strategy === "random" ? "random" : "round-robin";
      if (allSameEffort && sharedEffort) {
        next.reasoningEffort = sharedEffort;
      } else {
        delete next.reasoningEffort;
      }
      return next;
    }

    // ── effort capability check ──────────────────────────────────────────
    // A configured `reasoningEffort` that the target model does not declare
    // makes every delegation fail before its first request: the harness
    // assembles no system prompt and injects no context, so the subagent looks
    // like "nothing was injected". The provider catalog is the only source of
    // truth for that capability, and it can lag (a model may declare efforts
    // only after its directory refreshes). Report the mismatch in the panel so
    // the user learns it before saving, instead of diagnosing a silent failure.
    //
    // Pure: given one route and the loaded catalog groups, return the
    // diagnostic key + params, or null when the route is fine or unknown.
    // An unknown provider/model yields null: an absent catalog entry must
    // never be reported as "unsupported" (the model may be valid but simply
    // not advertised yet).
    function checkEffortSupport(route, groups) {
      if (!route || !route.provider || !route.model) return null;
      if (!route.reasoningEffort) return null;
      if (!Array.isArray(groups)) return null;
      var group = null;
      for (var i = 0; i < groups.length; i++) {
        if (groups[i] && groups[i].id === route.provider) { group = groups[i]; break; }
      }
      if (!group || !Array.isArray(group.models)) return null;
      var model = null;
      for (var j = 0; j < group.models.length; j++) {
        if (group.models[j] && group.models[j].id === route.model) { model = group.models[j]; break; }
      }
      if (!model) return null;
      var reasoning = model.reasoning;
      var efforts = reasoning && Array.isArray(reasoning.efforts) ? reasoning.efforts : [];
      if (efforts.length === 0) return { key: "row.effortNoDeclaration", params: {} };
      for (var k = 0; k < efforts.length; k++) {
        if (efforts[k] && efforts[k].id === route.reasoningEffort) return null;
      }
      return { key: "row.effortNotDeclared", params: { effort: route.reasoningEffort } };
    }

    function persistDefaultModels(scope, value) {
      // Every `set()` answers whether the Host ACCEPTED that field, and the
      // chain must stop at the first refusal. Ignoring the answers (which this
      // used to do) turns a half-written section into a "successful" save: the
      // caller sees the promise resolve, the card then compares the verdict
      // against a section that only partially changed, and reports a message
      // built from the SCOPE state instead of the real cause.
      //
      // A refusal (`false`) means the operation never reached the document: the
      // namespace is unbound, the page resolved `persistence: "memory"`, or the
      // Host rejected the write. The scope snapshot explains which, so carry it
      // in the same `notApplied:` shape the successful-but-not-landed case uses
      // — one actionable report, naming the field that was refused.
      var fields = [
        ["provider", value.provider],
        ["model", value.model],
        ["models", value.models],
        ["strategy", value.strategy],
        ["failoverEnabled", value.failoverEnabled === false ? false : true],
        ["injectRouteContext", value.injectRouteContext === false ? false : true],
        ["reasoningEffort", value.reasoningEffort || ""],
        ["roleMode", value.roleMode === true],
        ["exploreProvider", value.exploreProvider || ""],
        ["exploreModel", value.exploreModel || ""],
        ["exploreEffort", value.exploreEffort || ""],
        ["planProvider", value.planProvider || ""],
        ["planModel", value.planModel || ""],
        ["planEffort", value.planEffort || ""],
        ["patchProvider", value.patchProvider || ""],
        ["patchModel", value.patchModel || ""],
        ["patchEffort", value.patchEffort || ""],
        ["exploreModels", Array.isArray(value.exploreModels) ? value.exploreModels : []],
        ["planModels", Array.isArray(value.planModels) ? value.planModels : []],
        ["patchModels", Array.isArray(value.patchModels) ? value.patchModels : []],
        ["roleSlotCooldownSeconds", normalizeRoleCooldownSeconds(value.roleSlotCooldownSeconds)],
        ["teamModelProvider", value.teamModelProvider || ""],
        ["teamModelName", value.teamModelName || ""],
        ["teamModelEffort", value.teamModelEffort || ""],
        ["exemptRules", Array.isArray(value.exemptRules) ? value.exemptRules : []],
        ["forkWindowSlicing", value.forkWindowSlicing !== false],
        ["forkWindowTurns", normalizeForkWindowTurns(value.forkWindowTurns)],
        ["showChatModelNotice", value.showChatModelNotice === true]
      ];
      // ONE atomic mutation, when the bound controller offers it.
      //
      // This is the stronger fix, because the six operations are one logical
      // save and only the atomic form keeps them one Host transaction. Written
      // as six independent `set()` calls, each takes its OWN expectedRevision
      // from the controller, and every accepted write makes the controller fold
      // the new revision in. `configEditor.edit()` then reloads the entry, so
      // the fiber identity (and therefore the revision) changes underneath the
      // chain: a later field is refused with a revision conflict while the
      // promise still resolves, the read-back shows the earlier fields only,
      // and Save reports `notApplied:ready:writable=true` — accepted, writable,
      // and mysteriously not applied. `mutate()` sends the whole set against one
      // revision, so it either lands entirely or refuses once, actionably.
      var snapshotPart = function () {
        var snap = scope.getSnapshot();
        return ":" + String(snap ? snap.status : "noScope")
          + ":writable=" + String(snap ? snap.writable : false)
          + ":rev=" + String(snap && snap.revision !== void 0 ? snap.revision : "?");
      };
      var refused = function (field, path) {
        return new Error("notApplied" + snapshotPart() + ":refused=" + field + ":write=" + path);
      };
      // A refusal is usually a revision fence, and the controller has ALREADY
      // recovered by then: `ConfigFormController.mutate()` answers `false` only
      // after `recover()` reloaded Host state into the mirror. One immediate
      // retry therefore carries the fresh revision and is expected to land;
      // only a SECOND refusal is a real failure worth reporting.
      var retryAfterRecovery = function (attempt, write) {
        return Promise.resolve(write()).then(function (accepted) {
          if (accepted !== false) return accepted;
          if (attempt >= 2) return false;
          var refreshed = typeof scope.refresh === "function" ? scope.refresh() : Promise.resolve();
          return Promise.resolve(refreshed).catch(function () { /* refresh is best-effort */ }).then(function () {
            return retryAfterRecovery(attempt + 1, write);
          });
        });
      };
      // Fallback for a controller without `mutate`: sequential, but stop at the
      // first refusal so a partial write is never reported as a success.
      var sequential = function () {
        var chain = Promise.resolve(true);
        fields.forEach(function (entry) {
          chain = chain.then(function () {
            return retryAfterRecovery(1, function () { return scope.set(entry[0], entry[1]); }).then(function (accepted) {
              if (accepted === false) throw refused(entry[0], "sequential");
              return accepted;
            });
          });
        });
        return chain.then(function () { return "sequential"; });
      };
      if (typeof scope.setMany !== "function") return sequential();
      return retryAfterRecovery(1, function () { return scope.setMany(fields); }).then(function (accepted) {
        // `undefined` means the scope had no atomic form to offer (unbound, or a
        // controller without `mutate`). That is NOT a success: treating it as one
        // would report a save that wrote nothing at all. Fall back instead.
        if (accepted === void 0) return sequential();
        if (accepted === false) throw refused("all", "atomic");
        return "atomic";
      });
    }

    function useSettingsScopeSnapshot(scope) {
      var getSnap = function () {
        return scope && typeof scope.getSnapshot === "function"
          ? scope.getSnapshot()
          : { status: "unavailable", value: void 0, writable: false };
      };
      var snapshotState = React.useState(getSnap);
      React.useEffect(function () {
        if (!scope || typeof scope.subscribe !== "function") return;
        function update() { snapshotState[1](getSnap()); }
        return scope.subscribe(update);
      }, [scope]);
      return snapshotState[0];
    }

    // ── SubagentModelRow component ───────────────────────────────────────
    function SubagentModelRow(props) {
      var t = props.t;
      var snap = useSettingsScopeSnapshot(props.settingsScope);
      var value = (snap && snap.status === "ready" && snap.value) || {};
      var groupsState = React.useState([]);
      // Seed from the SAVED form when one is held (the mirror may still serve
      // the previous document after a save; observed-live the remounted card
      // then showed the route the user had just deleted). The held form is a
      // FINGERPRINT of the whole form (base routes + every role's candidate
      // list + cooldown); `seedFromSavedForm` rebuilds a section from it
      // instead of trusting the lagging mirror. Falls back to the mirror value
      // when nothing is held — the normal, converged case.
      var seedValue = (function () {
        var held = typeof props.settingsScope.savedForm === "function" ? props.settingsScope.savedForm() : null;
        return seedFromSavedForm(held, value);
      })();
      var routesState = React.useState(normalizeDefaultModels(seedValue));
      var strategyState = React.useState(seedValue.strategy === "random" ? "random" : "round-robin");
      var failoverEnabledState = React.useState(seedValue.failoverEnabled !== false);
      // Default ON, matching the schema default: `!== false` reads an absent
      // value as enabled, so an existing config that never mentioned the field
      // shows the checkbox ticked and keeps injecting.
      var injectRouteContextState = React.useState(seedValue.injectRouteContext !== false);
      var showChatModelNoticeState = React.useState(seedValue.showChatModelNotice === true);
      updateNoticeEnabled(seedValue.showChatModelNotice === true);
      var showHeaderCrittersState = React.useState(seedValue.showHeaderCritters !== false);
      updateCrittersEnabled(seedValue.showHeaderCritters !== false);
      var forkWindowSlicingState = React.useState(seedValue.forkWindowSlicing !== false);
      var forkWindowTurnsState = React.useState(normalizeForkWindowTurns(seedValue.forkWindowTurns));
      var roleModeState = React.useState(seedValue.roleMode === true);
      var exploreProviderState = React.useState(seedValue.exploreProvider || "");
      var exploreModelState = React.useState(seedValue.exploreModel || "");
      var exploreEffortState = React.useState(seedValue.exploreEffort || "");
      var planProviderState = React.useState(seedValue.planProvider || "");
      var planModelState = React.useState(seedValue.planModel || "");
      var planEffortState = React.useState(seedValue.planEffort || "");
      var patchProviderState = React.useState(seedValue.patchProvider || "");
      var patchModelState = React.useState(seedValue.patchModel || "");
      var patchEffortState = React.useState(seedValue.patchEffort || "");
      // Candidate pools per role: the ordered lane list the routing actually
      // consumes. Seeded from `*Models` when present, else from the legacy
      // single route, so an existing profile shows its current route as lane 1.
      var exploreRoutesState = React.useState(normalizeRoleRoutes(seedValue, "explore"));
      var planRoutesState = React.useState(normalizeRoleRoutes(seedValue, "plan"));
      var patchRoutesState = React.useState(normalizeRoleRoutes(seedValue, "patch"));
      var roleCooldownState = React.useState(normalizeRoleCooldownSeconds(seedValue.roleSlotCooldownSeconds));
      // Agent-teams birth model (three plain fields, mirroring the role-card
      // pattern). Empty provider/model = "leave members on the team default".
      var teamProviderState = React.useState(seedValue.teamModelProvider || "");
      var teamModelState = React.useState(seedValue.teamModelName || "");
      var teamEffortState = React.useState(seedValue.teamModelEffort || "");
      var exemptRulesState = React.useState(normalizeExemptRules(seedValue));
      // Exemption list interactions follow the "read list + one editor" rule
      // pattern: rows render as read-only sentences, and exactly one editor
      // (new or edit) can be open at a time. The editor keeps its own draft so
      // 取消 never disturbs the saved rules, and only 保存规则 writes the draft
      // into exemptRulesState (which is what marks the whole form dirty).
      // Delete needs a second click ("arm"), so a stray ✕ cannot silently drop
      // a rule. Both collapse when the section re-seeds from storage.
      var exemptEditorState = React.useState(null);
      var exemptArmState = React.useState(-1);
      var exemptArmTimer = React.useRef(null);
      var exemptCandidatesState = React.useState([]);

      var savedState = React.useState(false);
      // The failure REASON, not a boolean. A boolean was dead state here (written
      // but never read), so a refused write produced no visible feedback at all —
      // the button simply appeared to do nothing. The family cards all surface a
      // message (`row.saveError` in workbuddy/trae); this now does the same.
      var saveErrorState = React.useState(null);
      var toastState = React.useState(null);
      var toastSeq = React.useRef(0);
      var dirtyState = React.useState(false);
      var busyState = React.useState(false);
      React.useEffect(function () {
        var alive = true;
        props.loadCatalog().then(function (groups) {
          if (alive) groupsState[1](groups);
        }).catch(function () {});
        return function () { alive = false; };
      }, []);
      React.useEffect(function () {
        if (dirtyState[0] || busyState[0]) return;
        // The last completed save lives on the SCOPE (plugin lifetime), not in
        // this component: the card unmounts whenever the user leaves the
        // Plugins page, and a value held only in component state would die with
        // it — the remounted card would then re-seed from whatever the mirror
        // answers, which observed-live can still be the PREVIOUS document long
        // after the write landed. Holding it on the scope means the remounted
        // card seeds from what was actually SAVED.
        var saved = typeof props.settingsScope.savedForm === "function" ? props.settingsScope.savedForm() : null;
        if (saved !== null) {
          // A save is held: a mirror still serving the previous document must
          // not overwrite the just-saved form (that is the resurrection). Only
          // a mirror that agrees with the save — i.e. the Host's reload has
          // actually propagated — may re-seed again.
          if (savedFormFingerprint(value) !== saved) return;
          if (typeof props.settingsScope.clearSavedForm === "function") props.settingsScope.clearSavedForm();
        }
        routesState[1](normalizeDefaultModels(value));
        strategyState[1](value.strategy === "random" ? "random" : "round-robin");
        failoverEnabledState[1](value.failoverEnabled !== false);
        injectRouteContextState[1](value.injectRouteContext !== false);
        showChatModelNoticeState[1](value.showChatModelNotice === true);
        updateNoticeEnabled(value.showChatModelNotice === true);
        showHeaderCrittersState[1](value.showHeaderCritters !== false);
        updateCrittersEnabled(value.showHeaderCritters !== false);
        forkWindowSlicingState[1](value.forkWindowSlicing !== false);
        forkWindowTurnsState[1](normalizeForkWindowTurns(value.forkWindowTurns));
        roleModeState[1](value.roleMode === true);
        exploreProviderState[1](value.exploreProvider || "");
        exploreModelState[1](value.exploreModel || "");
        exploreEffortState[1](value.exploreEffort || "");
        planProviderState[1](value.planProvider || "");
        planModelState[1](value.planModel || "");
        planEffortState[1](value.planEffort || "");
        patchProviderState[1](value.patchProvider || "");
        patchModelState[1](value.patchModel || "");
        patchEffortState[1](value.patchEffort || "");
        exploreRoutesState[1](normalizeRoleRoutes(value, "explore"));
        planRoutesState[1](normalizeRoleRoutes(value, "plan"));
        patchRoutesState[1](normalizeRoleRoutes(value, "patch"));
        roleCooldownState[1](normalizeRoleCooldownSeconds(value.roleSlotCooldownSeconds));
        teamProviderState[1](value.teamModelProvider || "");
        teamModelState[1](value.teamModelName || "");
        teamEffortState[1](value.teamModelEffort || "");
        exemptRulesState[1](normalizeExemptRules(value));
        savedState[1](false);
        saveErrorState[1](null);
      }, [snap ? snap.revision : -1, dirtyState[0], busyState[0]]);
      function updateRoute(index, field, nextValue) {
        routesState[1](function (routes) {
          return routes.map(function (route, routeIndex) {
            if (routeIndex !== index) return route;
            var next = { provider: route.provider, model: route.model, reasoningEffort: route.reasoningEffort || "" };
            next[field] = nextValue;
            if (field === "provider") {
              next.model = "";
              next.reasoningEffort = "";
            }
            return next;
          });
        });
        savedState[1](false);
        saveErrorState[1](null);
        dirtyState[1](true);
      }
      function addRoute() {
        var firstGroup = groupsState[0][0];
        routesState[1](function (routes) {
          return routes.concat({ provider: firstGroup ? firstGroup.id : "", model: "", reasoningEffort: "" });
        });
        savedState[1](false);
        saveErrorState[1](null);
        dirtyState[1](true);
      }
      function removeRoute(index) {
        routesState[1](function (routes) { return routes.filter(function (_, routeIndex) { return routeIndex !== index; }); });
        savedState[1](false);
        saveErrorState[1](null);
        dirtyState[1](true);
      }
      // ── role pool row editing ──────────────────────────────────────────
      // One shared implementation for all three roles: the state setters are
      // passed in, so the row/card renderer stays generic.
      function markDirty() {
        savedState[1](false);
        saveErrorState[1](null);
        dirtyState[1](true);
      }
      function updateRoleRoute(state, index, field, nextValue) {
        state[1](function (routes) {
          return routes.map(function (route, routeIndex) {
            if (routeIndex !== index) return route;
            var next = { provider: route.provider, model: route.model, reasoningEffort: route.reasoningEffort || "" };
            next[field] = nextValue;
            // Changing the provider invalidates the model and its effort: the
            // new provider may not serve that model at all, and a stale effort
            // is the classic "the subagent cannot issue a single request" trap.
            if (field === "provider") {
              next.model = "";
              next.reasoningEffort = "";
            }
            if (field === "model") next.reasoningEffort = "";
            return next;
          });
        });
        markDirty();
      }
      function addRoleRoute(state) {
        var firstGroup = groupsState[0][0];
        state[1](function (routes) {
          return routes.concat({ provider: firstGroup ? firstGroup.id : "", model: "", reasoningEffort: "" });
        });
        markDirty();
      }
      function removeRoleRoute(state, index) {
        state[1](function (routes) {
          if (routes.length <= 1) return [blankRoleRoute()];
          return routes.filter(function (_, routeIndex) { return routeIndex !== index; });
        });
        markDirty();
      }
      // ── plugin exemption rule editing ──────────────────────────────────
      // The list itself is read-only; every mutation goes through the single
      // editor's draft (index < 0 = new rule). 取消 drops the draft without
      // touching anything; only 保存规则 writes it into exemptRulesState, which
      // is also what marks the whole form dirty. An EMPTY list is the normal
      // state (nothing exempt), and a rule without a pattern would be dropped
      // by serialize on save — so the editor disables 保存规则 until the draft
      // has something the backend can actually apply.
      function blankExemptDraft() {
        return { name: "", match: "label", pattern: "", provider: "", model: "", effort: "" };
      }
      function copyExemptDraft(source) {
        return {
          name: source.name || "",
          match: source.match || "label",
          pattern: source.pattern || "",
          provider: source.provider || "",
          model: source.model || "",
          effort: source.effort || ""
        };
      }
      function updateExemptDraft(field, nextValue) {
        exemptEditorState[1](function (editor) {
          if (editor === null) return editor;
          var draft = copyExemptDraft(editor.draft);
          draft[field] = nextValue;
          // Same cascade as the model cards: a new provider invalidates the
          // model and effort; a new model invalidates the effort.
          if (field === "provider") { draft.model = ""; draft.effort = ""; }
          if (field === "model") draft.effort = "";
          return { index: editor.index, draft: draft, pin: editor.pin };
        });
      }
      // The pin checkbox is its own piece of editor state: a freshly checked
      // box has no values yet, so "has pin" cannot be derived from the fields.
      // Unchecking explicitly clears the triple instead of merely hiding it —
      // the stored rule must never carry a pin the UI shows as off.
      function toggleExemptPin(checked) {
        exemptEditorState[1](function (editor) {
          if (editor === null) return editor;
          var draft = copyExemptDraft(editor.draft);
          if (!checked) { draft.provider = ""; draft.model = ""; draft.effort = ""; }
          return { index: editor.index, draft: draft, pin: checked };
        });
      }
      function openExemptEditor(index) {
        exemptArmState[1](-1);
        var rules = exemptRulesState[0];
        var source = index >= 0 && index < rules.length ? rules[index] : null;
        exemptEditorState[1]({
          index: index,
          draft: source ? copyExemptDraft(source) : blankExemptDraft(),
          pin: Boolean(source && (source.provider || source.model || source.effort))
        });
        // Refresh observed birth identities each time the editor opens; a
        // failed fetch keeps the previous list and the free-text input.
        exemptCandidatesGet().then(function (body) {
          var list = body && body.ok === true && body.value && Array.isArray(body.value.candidates)
            ? body.value.candidates
            : [];
          exemptCandidatesState[1](list);
        }, function () { exemptCandidatesState[1]([]); });
      }
      function closeExemptEditor() {
        exemptEditorState[1](null);
      }
      function exemptDraftIncomplete(draft, pinOn) {
        if (draft === null) return false;
        return !String(draft.pattern || "").trim() || (pinOn && (!draft.provider || !draft.model));
      }
      function applyExemptDraft() {
        var editor = exemptEditorState[0];
        var pinOn = editor !== null && editor.pin === true;
        if (editor === null || exemptDraftIncomplete(editor.draft, pinOn)) return;
        var draft = editor.draft;
        var rule = {
          name: draft.name || "",
          match: draft.match || "label",
          pattern: draft.pattern,
          provider: pinOn ? (draft.provider || "") : "",
          model: pinOn ? (draft.model || "") : "",
          effort: pinOn ? (draft.effort || "") : ""
        };
        exemptRulesState[1](function (rules) {
          if (editor.index < 0) return rules.concat([rule]);
          return rules.map(function (existing, ruleIndex) {
            return ruleIndex === editor.index ? rule : existing;
          });
        });
        exemptEditorState[1](null);
        markDirty();
      }
      function removeExemptRule(index) {
        exemptRulesState[1](function (rules) {
          return rules.filter(function (_, ruleIndex) { return ruleIndex !== index; });
        });
        exemptArmState[1](-1);
        markDirty();
      }
      // First ✕ only arms (the button turns into 确认删除); a second click
      // within the window deletes, otherwise the arm expires on its own.
      function armExemptDelete(index) {
        if (exemptArmTimer.current !== null) clearTimeout(exemptArmTimer.current);
        exemptArmState[1](index);
        exemptArmTimer.current = setTimeout(function () {
          exemptArmTimer.current = null;
          exemptArmState[1](-1);
        }, 4000);
      }
      function save() {
        // Attempt the write REGARDLESS of the scope's derived status.
        //
        // `ConfigFormController.mutate()` sends the operation straight to the
        // Host (`remote.settings.mutate`); only `persistence === 'memory'` makes
        // it refuse locally (`enqueue()`), and that case returns `false`, which
        // the verification below already catches and reports. The derived
        // `status`/`writable` come from the describe MIRROR (`derive()`), which is
        // a separate, asynchronously-filled read path — gating a write on it is
        // exactly the "Save can never be pressed" defect, merely relocated from
        // the button into an error message (observed: a bare
        // `settingsUnavailable` with the Host perfectly able to accept the write).
        //
        // So: try, then report what actually happened. That is what the family
        // cards do — `trae`/`workbuddy` disable on `!dirty || saving` and let the
        // write answer for itself.
        if (busyState[0]) return;
        var nextValue = serializeDefaultModels(value, routesState[0], strategyState[0], failoverEnabledState[0], injectRouteContextState[0], {
          roleMode: roleModeState[0],
          exploreProvider: exploreProviderState[0],
          exploreModel: exploreModelState[0],
          exploreEffort: exploreEffortState[0],
          planProvider: planProviderState[0],
          planModel: planModelState[0],
          planEffort: planEffortState[0],
          patchProvider: patchProviderState[0],
          patchModel: patchModelState[0],
          patchEffort: patchEffortState[0],
          rolePools: {
            explore: exploreRoutesState[0],
            plan: planRoutesState[0],
            patch: patchRoutesState[0]
          },
          roleSlotCooldownSeconds: roleCooldownState[0],
          teamModel: {
            provider: teamProviderState[0],
            model: teamModelState[0],
            effort: teamEffortState[0]
          },
          exemptRules: exemptRulesState[0]
        }, {
          forkWindowSlicing: forkWindowSlicingState[0],
          forkWindowTurns: forkWindowTurnsState[0]
        }, showChatModelNoticeState[0], showHeaderCrittersState[0]);
        savedState[1](false);
        saveErrorState[1](null);
        busyState[1](true);
        // Which write path persistDefaultModels took ("atomic" | "sequential"),
        // carried into every failure report so one paste is enough to tell the
        // two apart in the field.
        var writePath = "unknown";
        // Compare the stored section against what was just written. A landed
        // write is not immediately visible: `configEditor.edit()` re-creates the
        // entry's fiber, and the describe mirror only learns the new document
        // once that reload commits. So re-read through the scope (which forces a
        // mirror load and re-derives), retrying a few times, and only then judge.
        // Without the retry a perfectly accepted write is reported as
        // `notApplied:ready:writable=true`.
        var fieldDiff = function (acceptedValue) {
          var diffs = [];
          var note = function (field, got, exp) {
            diffs.push(field + "[got=" + JSON.stringify(got) + " exp=" + JSON.stringify(exp) + "]");
          };
          if (acceptedValue.provider !== nextValue.provider) note("provider", acceptedValue.provider, nextValue.provider);
          if (acceptedValue.model !== nextValue.model) note("model", acceptedValue.model, nextValue.model);
          if (acceptedValue.strategy !== nextValue.strategy) note("strategy", acceptedValue.strategy, nextValue.strategy);
          if ((acceptedValue.reasoningEffort || "") !== (nextValue.reasoningEffort || "")) note("reasoningEffort", acceptedValue.reasoningEffort, nextValue.reasoningEffort);
          if ((acceptedValue.failoverEnabled === false ? false : true) !== nextValue.failoverEnabled) note("failoverEnabled", acceptedValue.failoverEnabled, nextValue.failoverEnabled);
          if (JSON.stringify(acceptedValue.models || []) !== JSON.stringify(nextValue.models || [])) note("models", acceptedValue.models, nextValue.models);
          if ((acceptedValue.roleMode === true) !== (nextValue.roleMode === true)) note("roleMode", acceptedValue.roleMode, nextValue.roleMode);
          if ((acceptedValue.exploreModel || "") !== (nextValue.exploreModel || "")) note("exploreModel", acceptedValue.exploreModel, nextValue.exploreModel);
          if ((acceptedValue.planModel || "") !== (nextValue.planModel || "")) note("planModel", acceptedValue.planModel, nextValue.planModel);
          if ((acceptedValue.patchModel || "") !== (nextValue.patchModel || "")) note("patchModel", acceptedValue.patchModel, nextValue.patchModel);
          if (JSON.stringify(acceptedValue.exploreModels || []) !== JSON.stringify(nextValue.exploreModels || [])) note("exploreModels", acceptedValue.exploreModels, nextValue.exploreModels);
          if (JSON.stringify(acceptedValue.planModels || []) !== JSON.stringify(nextValue.planModels || [])) note("planModels", acceptedValue.planModels, nextValue.planModels);
          if (JSON.stringify(acceptedValue.patchModels || []) !== JSON.stringify(nextValue.patchModels || [])) note("patchModels", acceptedValue.patchModels, nextValue.patchModels);
          if (normalizeRoleCooldownSeconds(acceptedValue.roleSlotCooldownSeconds) !== normalizeRoleCooldownSeconds(nextValue.roleSlotCooldownSeconds)) note("roleSlotCooldownSeconds", acceptedValue.roleSlotCooldownSeconds, nextValue.roleSlotCooldownSeconds);
          if ((acceptedValue.teamModelProvider || "") !== (nextValue.teamModelProvider || "")) note("teamModelProvider", acceptedValue.teamModelProvider, nextValue.teamModelProvider);
          if ((acceptedValue.teamModelName || "") !== (nextValue.teamModelName || "")) note("teamModelName", acceptedValue.teamModelName, nextValue.teamModelName);
          if ((acceptedValue.teamModelEffort || "") !== (nextValue.teamModelEffort || "")) note("teamModelEffort", acceptedValue.teamModelEffort, nextValue.teamModelEffort);
          if (JSON.stringify(acceptedValue.exemptRules || []) !== JSON.stringify(nextValue.exemptRules || [])) note("exemptRules", acceptedValue.exemptRules, nextValue.exemptRules);
          if ((acceptedValue.showChatModelNotice === true) !== (nextValue.showChatModelNotice === true)) note("showChatModelNotice", acceptedValue.showChatModelNotice, nextValue.showChatModelNotice);
          if ((acceptedValue.showHeaderCritters !== false) !== (nextValue.showHeaderCritters !== false)) note("showHeaderCritters", acceptedValue.showHeaderCritters, nextValue.showHeaderCritters);
          if ((acceptedValue.forkWindowSlicing !== false) !== (nextValue.forkWindowSlicing !== false)) note("forkWindowSlicing", acceptedValue.forkWindowSlicing, nextValue.forkWindowSlicing);
          if (normalizeForkWindowTurns(acceptedValue.forkWindowTurns) !== normalizeForkWindowTurns(nextValue.forkWindowTurns)) note("forkWindowTurns", acceptedValue.forkWindowTurns, nextValue.forkWindowTurns);
          if ((acceptedValue.injectRouteContext !== false) !== (nextValue.injectRouteContext !== false)) note("injectRouteContext", acceptedValue.injectRouteContext, nextValue.injectRouteContext);
          return diffs;
        };
        var assertLanded = function (snap) {
          var acceptedValue = (snap && snap.status === "ready" && snap.value) || {};
          var diffs = fieldDiff(acceptedValue);
          if (diffs.length === 0) return { landed: true, acceptedValue: acceptedValue };
          return {
            landed: false,
            // Name the state that explains a write that did NOT land, so the
            // report stays actionable instead of generic. The field-level diff
            // and the mirror revision turn one paste of this message into
            // enough evidence to tell "the Host refused it", "it landed but the
            // read-back is stale", and "it landed in a different shape" apart.
            reason: "notApplied:" + String(snap ? snap.status : "noScope")
              + ":writable=" + String(snap ? snap.writable : false)
              + ":rev=" + String(snap && snap.revision !== void 0 ? snap.revision : "?")
              + ":write=" + writePath
              + ":diff=" + diffs.join(";")
          };
        };
        var READBACK_ATTEMPTS = 6;
        var READBACK_DELAY_MS = 250;
        var settleReadback = function (attempt) {
          var scope = props.settingsScope;
          var refreshed = scope && typeof scope.refresh === "function" ? scope.refresh() : Promise.resolve();
          return Promise.resolve(refreshed).then(function () {
            var verdict = assertLanded(scope.getSnapshot());
            if (verdict.landed) return verdict;
            if (attempt >= READBACK_ATTEMPTS) return verdict;
            // A reload may still be committing. Wait, then re-read, bounded.
            return new Promise(function (resolve) {
              if (typeof setTimeout !== "function") { resolve(); return; }
              setTimeout(resolve, READBACK_DELAY_MS);
            }).then(function () { return settleReadback(attempt + 1); });
          });
        };
        Promise.resolve().then(function () {
          return props.write(nextValue);
        }).then(function (path) {
          if (typeof path === "string" && path) writePath = path;
          return settleReadback(1);
        }).then(function (verdict) {
          var acceptedValue;
          var mirrorLagged = false;
          if (verdict.landed) {
            acceptedValue = verdict.acceptedValue;
          } else {
            // The write was ACCEPTED by the Host — `persistDefaultModels`
            // resolved, and any refusal would have thrown with `:refused=`.
            // An accepted write IS a landed write: `configEditor.edit()` only
            // resolves after the profile patch is written AND the Loader
            // reconciled, so a still-mismatching read-back can only mean the
            // describe MIRROR is serving the previous document while the
            // reload propagates through it. Reporting that as a failure is
            // precisely the false `notApplied:ready:writable=true` this card
            // became known for — observed live: the patch file held the new
            // value while the read-back kept answering the old one.
            //
            // So take the DRAFT as the saved truth here, and HOLD it: the
            // re-seed effect must not let the lagging mirror overwrite the
            // form (that resurrects deleted routes), so the saved form is
            // recorded in `lastSavedFormRef` and the poll below keeps
            // refreshing the mirror until it agrees, then hands control back.
            acceptedValue = nextValue;
            mirrorLagged = true;
            try {
              console.warn("[dsh-subagent-role-router] write accepted; the read-back mirror is still serving the previous document:", verdict.reason);
            } catch (_e) {}
          }
          // Hold the saved form ON THE SCOPE (plugin lifetime, survives the
          // card unmounting when the user switches away): the re-seed effect
          // only accepts a mirror that agrees with this from now on, and the
          // poll below releases the hold once the mirror converges.
          if (typeof props.settingsScope.setSavedForm === "function") {
            props.settingsScope.setSavedForm(savedFormFingerprint(acceptedValue));
          }
          routesState[1](normalizeDefaultModels(acceptedValue));
          strategyState[1](acceptedValue.strategy === "random" ? "random" : "round-robin");
          failoverEnabledState[1](acceptedValue.failoverEnabled !== false);
          injectRouteContextState[1](acceptedValue.injectRouteContext !== false);
          showChatModelNoticeState[1](acceptedValue.showChatModelNotice === true);
          updateNoticeEnabled(acceptedValue.showChatModelNotice === true);
          showHeaderCrittersState[1](acceptedValue.showHeaderCritters !== false);
          updateCrittersEnabled(acceptedValue.showHeaderCritters !== false);
          forkWindowSlicingState[1](acceptedValue.forkWindowSlicing !== false);
          forkWindowTurnsState[1](normalizeForkWindowTurns(acceptedValue.forkWindowTurns));
          exploreRoutesState[1](normalizeRoleRoutes(acceptedValue, "explore"));
          planRoutesState[1](normalizeRoleRoutes(acceptedValue, "plan"));
          patchRoutesState[1](normalizeRoleRoutes(acceptedValue, "patch"));
          roleCooldownState[1](normalizeRoleCooldownSeconds(acceptedValue.roleSlotCooldownSeconds));
          teamProviderState[1](acceptedValue.teamModelProvider || "");
          teamModelState[1](acceptedValue.teamModelName || "");
          teamEffortState[1](acceptedValue.teamModelEffort || "");
          dirtyState[1](false);
          busyState[1](false);
          savedState[1](true);
          saveErrorState[1](null);
          toastSeq.current = toastSeq.current + 1;
          toastState[1]({ seq: toastSeq.current, text: t("row.toastSaved") });
          if (mirrorLagged) {
            // Bounded background convergence: keep re-reading the mirror until
            // it serves what the Host verifiably stored. Each load() drives the
            // scope subscription, so when the mirror finally agrees, the held
            // re-seed effect runs with the agreeing value (a no-op against the
            // draft we already seeded) and clears the hold. If the mirror never
            // catches up, the form simply keeps the saved truth — never the
            // stale document it was saved from. The hold lives on the scope,
            // so it survives the card unmounting mid-poll: the remounted card
            // seeds from the saved truth, not the lagging mirror.
            var POLL_ATTEMPTS = 20;
            var POLL_DELAY_MS = 500;
            var pollMirror = function (attempt) {
              var scope = props.settingsScope;
              var held = typeof scope.savedForm === "function" ? scope.savedForm() : null;
              if (held === null || held === void 0) return; // already converged (or a newer save took over)
              var refreshed = scope && typeof scope.refresh === "function" ? scope.refresh() : Promise.resolve();
              Promise.resolve(refreshed).catch(function () {}).then(function () {
                var snapNow = scope ? scope.getSnapshot() : void 0;
                var stored = (snapNow && snapNow.status === "ready" && snapNow.value) || {};
                if (savedFormFingerprint(stored) === held) {
                  // Converged: release the hold. The mirror-driven re-render
                  // now re-seeds from the agreed document — identical to the
                  // draft — and normal sync resumes.
                  if (typeof scope.clearSavedForm === "function") scope.clearSavedForm();
                  routesState[1](normalizeDefaultModels(stored));
                  strategyState[1](stored.strategy === "random" ? "random" : "round-robin");
                  failoverEnabledState[1](stored.failoverEnabled !== false);
                  injectRouteContextState[1](stored.injectRouteContext !== false);
                  showChatModelNoticeState[1](stored.showChatModelNotice === true);
                  updateNoticeEnabled(stored.showChatModelNotice === true);
                  showHeaderCrittersState[1](stored.showHeaderCritters !== false);
                  updateCrittersEnabled(stored.showHeaderCritters !== false);
                  forkWindowSlicingState[1](stored.forkWindowSlicing !== false);
                  forkWindowTurnsState[1](normalizeForkWindowTurns(stored.forkWindowTurns));
                  exploreRoutesState[1](normalizeRoleRoutes(stored, "explore"));
                  planRoutesState[1](normalizeRoleRoutes(stored, "plan"));
                  patchRoutesState[1](normalizeRoleRoutes(stored, "patch"));
                  roleCooldownState[1](normalizeRoleCooldownSeconds(stored.roleSlotCooldownSeconds));
                  teamProviderState[1](stored.teamModelProvider || "");
                  teamModelState[1](stored.teamModelName || "");
                  teamEffortState[1](stored.teamModelEffort || "");
                  exemptRulesState[1](normalizeExemptRules(stored));
                  exemptEditorState[1](null);
                  exemptArmState[1](-1);
                  return;
                }
                if (attempt >= POLL_ATTEMPTS) {
                  try { console.warn("[dsh-subagent-role-router] the describe mirror never caught up with the accepted write; the form keeps the saved draft."); } catch (_e) {}
                  return;
                }
                return new Promise(function (resolve) {
                  if (typeof setTimeout !== "function") { resolve(); return; }
                  setTimeout(resolve, POLL_DELAY_MS);
                }).then(function () { return pollMirror(attempt + 1); });
              });
            };
            pollMirror(1);
          }
        }).catch(function (error) {
          busyState[1](false);
          saveErrorState[1](error && error.message ? error.message : "writeRefused");
        });
      }
      function discard() {
        routesState[1](normalizeDefaultModels(value));
        strategyState[1](value.strategy === "random" ? "random" : "round-robin");
        failoverEnabledState[1](value.failoverEnabled !== false);
        injectRouteContextState[1](value.injectRouteContext !== false);
        showChatModelNoticeState[1](value.showChatModelNotice === true);
        updateNoticeEnabled(value.showChatModelNotice === true);
        showHeaderCrittersState[1](value.showHeaderCritters !== false);
        updateCrittersEnabled(value.showHeaderCritters !== false);
        forkWindowSlicingState[1](value.forkWindowSlicing !== false);
        forkWindowTurnsState[1](normalizeForkWindowTurns(value.forkWindowTurns));
        exploreRoutesState[1](normalizeRoleRoutes(value, "explore"));
        planRoutesState[1](normalizeRoleRoutes(value, "plan"));
        patchRoutesState[1](normalizeRoleRoutes(value, "patch"));
        roleCooldownState[1](normalizeRoleCooldownSeconds(value.roleSlotCooldownSeconds));
        teamProviderState[1](value.teamModelProvider || "");
        teamModelState[1](value.teamModelName || "");
        teamEffortState[1](value.teamModelEffort || "");
        exemptRulesState[1](normalizeExemptRules(value));
        exemptEditorState[1](null);
        exemptArmState[1](-1);
        dirtyState[1](false);
        savedState[1](false);
        saveErrorState[1](null);
        toastState[1](null);
      }
      var hasIncompleteRoute = routesState[0].some(function (route) { return !route.provider || !route.model; });
      // A fully blank role row is an UNUSED lane, not an error: adding a spare
      // row and saving must work, because "how many lanes" is expressed by row
      // count. Only a half-filled row (provider without model, or the reverse)
      // has nothing valid to write. Gated on roleMode: with the roles switched
      // off, a stale half-filled row must not block saving the base pool.
      var hasIncompleteRoleRoute = roleModeState[0] && (roleRouteIncomplete(exploreRoutesState[0])
        || roleRouteIncomplete(planRoutesState[0])
        || roleRouteIncomplete(patchRoutesState[0]));
      // A half-pinned exemption rule (provider without model, or the reverse)
      // would store a rule the backend can never apply as written.
      var hasIncompleteExempt = exemptRuleIncomplete(exemptRulesState[0]);
      var effortWarnings = [];
      routesState[0].forEach(function (route, index) {
        var warning = checkEffortSupport(route, groupsState[0]);
        if (warning !== null) effortWarnings.push({ index: index, key: warning.key, warning: warning });
      });
      // Role lanes need the same capability check: an effort the target model
      // does not declare makes every delegation on that lane fail before its
      // first request, which reads as "nothing happened" in the UI.
      [["explore", exploreRoutesState[0]], ["plan", planRoutesState[0]], ["patch", patchRoutesState[0]]].forEach(function (pair) {
        pair[1].forEach(function (route, index) {
          var warning = checkEffortSupport(route, groupsState[0]);
          if (warning !== null) effortWarnings.push({ index: pair[0] + ":" + index, key: warning.key, warning: warning });
        });
      });
      // Save gate, aligned with the family cards (`trae` / `workbuddy` disable on
      // `!dirty || saving` plus one content rule). Two scope gates used to sit
      // here — `snap.status !== "ready"` and `snap.writable === false` — and they
      // are exactly what made Save permanently unclickable: the settings scope is
      // bound asynchronously from the describe mirror, so while the mirror has not
      // answered (or the Host never serves this namespace) both conditions stay
      // true forever, the button stays grey, and no message ever explains why.
      // The family does not pre-gate on scope state: it lets the write happen and
      // reports the refusal. `hasIncompleteRoute` stays, because a half-filled
      // route genuinely has nothing valid to save — the family's equivalent of
      // "no models enabled".
      var saveDisabled = busyState[0] || !dirtyState[0] || hasIncompleteRoute || hasIncompleteRoleRoute || hasIncompleteExempt;
      var discardDisabled = !dirtyState[0] || busyState[0];
      var routes = routesState[0].map(function (route, index) {
        var group = null;
        for (var groupIndex = 0; groupIndex < groupsState[0].length; groupIndex++) {
          if (groupsState[0][groupIndex].id === route.provider) { group = groupsState[0][groupIndex]; break; }
        }
        var providerChoices = groupsState[0].slice();
        if (route.provider && !group) providerChoices.unshift({ id: route.provider, name: route.provider });
        var modelChoices = group ? (group.models || []).slice() : [];
        if (route.model && !modelChoices.some(function (candidate) { return candidate.id === route.model; })) {
          modelChoices.unshift({ id: route.model, name: route.model });
        }
        var selectedModel = null;
        for (var modelIndex = 0; modelIndex < modelChoices.length; modelIndex++) {
          if (modelChoices[modelIndex].id === route.model) { selectedModel = modelChoices[modelIndex]; break; }
        }
        var effortChoices = selectedModel && selectedModel.reasoning && Array.isArray(selectedModel.reasoning.efforts) && selectedModel.reasoning.efforts.length > 0
          ? selectedModel.reasoning.efforts.slice()
          : [
              { id: "low", name: "低 (low)" },
              { id: "medium", name: "中 (medium / mid)" },
              { id: "high", name: "高 (high)" }
            ];
        if (route.reasoningEffort && !effortChoices.some(function (candidate) { return candidate.id === route.reasoningEffort; })) {
          effortChoices.unshift({ id: route.reasoningEffort, name: route.reasoningEffort });
        }
        // Non-blocking capability warning: saving is still allowed (a catalog
        // that has not refreshed yet must not trap the user), but a mismatch is
        // surfaced here rather than discovered later as a subagent that starts
        // no request at all.
        var effortWarning = checkEffortSupport(route, groupsState[0]);
        return React.createElement("div", { className: "dsm-model-settings-route", key: index },
          React.createElement("label", { className: "dsm-model-settings-field" },
            t("row.provider"),
            React.createElement("select", {
              className: "dsm-model-settings-select",
              value: route.provider,
              onChange: function (event) { updateRoute(index, "provider", event.target.value); }
            },
              React.createElement("option", { value: "" }, t("row.inherit")),
              providerChoices.map(function (candidate) {
                return React.createElement("option", { key: candidate.id, value: candidate.id }, candidate.name + " (" + candidate.id + ")");
              })
            )
          ),
          React.createElement("label", { className: "dsm-model-settings-field" },
            t("row.model"),
            React.createElement("select", {
              className: "dsm-model-settings-select",
              value: route.model,
              disabled: !route.provider,
              onChange: function (event) { updateRoute(index, "model", event.target.value); }
            },
              React.createElement("option", { value: "" }, t("row.inherit")),
              modelChoices.map(function (candidate) {
                return React.createElement("option", { key: candidate.id, value: candidate.id }, candidate.name || candidate.id);
              })
            )
          ),
          React.createElement("label", { className: "dsm-model-settings-field" },
            t("row.effort"),
            React.createElement("select", {
              className: "dsm-model-settings-select",
              value: route.reasoningEffort || "",
              disabled: !route.model,
              onChange: function (event) { updateRoute(index, "reasoningEffort", event.target.value); }
            },
              React.createElement("option", { value: "" }, t("row.effortDefault")),
              effortChoices.map(function (candidate) {
                return React.createElement("option", { key: candidate.id, value: candidate.id }, candidate.name || candidate.id);
              })
            )
          ),
          React.createElement("button", {
            className: "dsm-model-settings-remove",
            type: "button",
            "aria-label": t("row.remove"),
            title: t("row.remove"),
            onClick: function () { removeRoute(index); }
          }, "×"),
          effortWarning === null ? null : React.createElement("div", {
            className: "dsm-model-settings-warn",
            role: "status",
            "data-effort-warning": effortWarning.key
          }, t(effortWarning.key, effortWarning.params))
        );
      });
      
      // ── one role card: an ordered list of candidate lanes ────────────────
      //
      // The card renders one row per lane, in the order the router tries them.
      // The row markup is deliberately the SAME as the base pool's rows
      // (`dsm-model-settings-route` and friends) so the two lists look and
      // behave alike; only the header/hint and the trailing "add lane" button
      // are specific to a role.
      function renderRoleCard(roleTitle, roleDesc, routesState) {
        var rows = routesState[0].map(function (route, index) {
          var group = null;
          for (var gi = 0; gi < groupsState[0].length; gi++) {
            if (groupsState[0][gi].id === route.provider) { group = groupsState[0][gi]; break; }
          }
          var pChoices = groupsState[0].slice();
          if (route.provider && !group) pChoices.unshift({ id: route.provider, name: route.provider });
          var mChoices = group ? (group.models || []).slice() : [];
          if (route.model && !mChoices.some(function (c) { return c.id === route.model; })) {
            mChoices.unshift({ id: route.model, name: route.model });
          }
          var selectedM = null;
          for (var mi = 0; mi < mChoices.length; mi++) {
            if (mChoices[mi].id === route.model) { selectedM = mChoices[mi]; break; }
          }
          var eChoices = selectedM && selectedM.reasoning && Array.isArray(selectedM.reasoning.efforts) && selectedM.reasoning.efforts.length > 0
            ? selectedM.reasoning.efforts.slice()
            : [
                { id: "low", name: "低 (low)" },
                { id: "medium", name: "中 (medium / mid)" },
                { id: "high", name: "高 (high)" }
              ];
          if (route.reasoningEffort && !eChoices.some(function (c) { return c.id === route.reasoningEffort; })) {
            eChoices.unshift({ id: route.reasoningEffort, name: route.reasoningEffort });
          }
          var effortWarning = checkEffortSupport(route, groupsState[0]);
          return React.createElement("div", { className: "dsm-model-settings-route", key: index },
            React.createElement("label", { className: "dsm-model-settings-field" },
              t("row.provider"),
              React.createElement("select", {
                className: "dsm-model-settings-select",
                value: route.provider,
                onChange: function (ev) { updateRoleRoute(routesState, index, "provider", ev.target.value); }
              },
                React.createElement("option", { value: "" }, t("row.inherit")),
                pChoices.map(function (c) {
                  return React.createElement("option", { key: c.id, value: c.id }, c.name + " (" + c.id + ")");
                })
              )
            ),
            React.createElement("label", { className: "dsm-model-settings-field" },
              t("row.model"),
              React.createElement("select", {
                className: "dsm-model-settings-select",
                value: route.model,
                disabled: !route.provider,
                onChange: function (ev) { updateRoleRoute(routesState, index, "model", ev.target.value); }
              },
                React.createElement("option", { value: "" }, t("row.inherit")),
                mChoices.map(function (c) {
                  return React.createElement("option", { key: c.id, value: c.id }, c.name || c.id);
                })
              )
            ),
            React.createElement("label", { className: "dsm-model-settings-field" },
              t("row.effort"),
              React.createElement("select", {
                className: "dsm-model-settings-select",
                value: route.reasoningEffort || "",
                disabled: !route.model,
                onChange: function (ev) { updateRoleRoute(routesState, index, "reasoningEffort", ev.target.value); }
              },
                React.createElement("option", { value: "" }, t("row.effortDefault")),
                eChoices.map(function (c) {
                  return React.createElement("option", { key: c.id, value: c.id }, c.name || c.id);
                })
              )
            ),
            React.createElement("button", {
              className: "dsm-model-settings-remove",
              type: "button",
              disabled: routesState[0].length <= 1,
              "aria-label": t("row.roleRemoveSlot"),
              title: t("row.roleRemoveSlot"),
              onClick: function () { removeRoleRoute(routesState, index); }
            }, "\u2212"),
            effortWarning === null ? null : React.createElement("div", {
              className: "dsm-model-settings-warn",
              role: "status",
              "data-effort-warning": effortWarning.key
            }, t(effortWarning.key, effortWarning.params))
          );
        });

        return React.createElement("div", {
          className: "dsm-role-card",
          style: {
            background: "rgba(255, 255, 255, 0.03)",
            border: "1px solid rgba(255, 255, 255, 0.08)",
            borderRadius: "8px",
            padding: "12px",
            marginBottom: "10px"
          }
        },
          React.createElement("div", { style: { fontWeight: "600", fontSize: "13px", marginBottom: "4px" } }, roleTitle),
          React.createElement("div", { style: { fontSize: "12px", opacity: 0.7, marginBottom: "8px" } }, roleDesc),
          React.createElement("div", { className: "dsm-model-settings-list" }, rows),
          React.createElement("div", {
            style: {
              display: "flex",
              alignItems: "center",
              gap: "10px",
              flexWrap: "wrap",
              marginTop: "8px"
            }
          },
            React.createElement("button", {
              type: "button",
              className: "dsm-btn dsm-btn-outline",
              onClick: function () { addRoleRoute(routesState); }
            }, t("row.roleAddSlot")),
            React.createElement("span", { className: "dsm-inject-route-hint" }, t("row.roleSlotHint"))
          )
        );
      }

      /**
       * The agent-teams birth model card: one provider/model/effort triplet.
       *
       * Deliberately NOT a candidate pool — a team spawn takes no lanes,
       * cooldowns, or failover (see `teamBirthModel` on the host side), so one
       * row is the honest shape. The effort list only offers what the chosen
       * model declares: the live picker's "never invent an effort the model
       * will reject" rule applies here too.
       */
      function renderTeamModelCard() {
        var provider = teamProviderState[0];
        var model = teamModelState[0];
        var effort = teamEffortState[0];
        var group = null;
        for (var gi = 0; gi < groupsState[0].length; gi++) {
          if (groupsState[0][gi].id === provider) { group = groupsState[0][gi]; break; }
        }
        var pChoices = groupsState[0].slice();
        if (provider && !group) pChoices.unshift({ id: provider, name: provider });
        var mChoices = group ? (group.models || []).slice() : [];
        if (model && !mChoices.some(function (c) { return c.id === model; })) {
          mChoices.unshift({ id: model, name: model });
        }
        var selectedM = null;
        for (var mi = 0; mi < mChoices.length; mi++) {
          if (mChoices[mi].id === model) { selectedM = mChoices[mi]; break; }
        }
        var declared = selectedM && selectedM.reasoning && Array.isArray(selectedM.reasoning.efforts)
          ? selectedM.reasoning.efforts.slice()
          : [];
        if (effort && !declared.some(function (c) { return c.id === effort; })) {
          declared.unshift({ id: effort, name: effort });
        }
        var teamWarning = checkEffortSupport(
          provider && model ? { provider: provider, model: model, reasoningEffort: effort || "" } : null,
          groupsState[0]
        );
        return React.createElement("div", {
          className: "dsm-team-model-card",
          style: {
            background: "rgba(255, 255, 255, 0.03)",
            border: "1px solid rgba(255, 255, 255, 0.08)",
            borderRadius: "8px",
            padding: "12px",
            marginBottom: "10px"
          }
        },
          React.createElement("div", { style: { fontWeight: "600", fontSize: "13px", marginBottom: "4px" } }, t("row.teamModelTitle")),
          React.createElement("div", { style: { fontSize: "12px", opacity: 0.7, marginBottom: "8px" } }, t("row.teamModelDesc")),
          React.createElement("div", { className: "dsm-model-settings-route" },
            React.createElement("label", { className: "dsm-model-settings-field" },
              t("row.provider"),
              React.createElement("select", {
                className: "dsm-model-settings-select",
                value: provider,
                onChange: function (ev) {
                  var next = ev.target.value;
                  teamProviderState[1](next);
                  // Changing provider invalidates the model and its effort —
                  // same cascade rule as the role-card rows.
                  teamModelState[1]("");
                  teamEffortState[1]("");
                  markDirty();
                }
              },
                React.createElement("option", { value: "" }, t("row.teamModelDefault")),
                pChoices.map(function (c) {
                  return React.createElement("option", { key: c.id, value: c.id }, c.name + " (" + c.id + ")");
                })
              )
            ),
            React.createElement("label", { className: "dsm-model-settings-field" },
              t("row.model"),
              React.createElement("select", {
                className: "dsm-model-settings-select",
                value: model,
                disabled: !provider,
                onChange: function (ev) {
                  teamModelState[1](ev.target.value);
                  teamEffortState[1]("");
                  markDirty();
                }
              },
                React.createElement("option", { value: "" }, t("row.teamModelDefault")),
                mChoices.map(function (c) {
                  return React.createElement("option", { key: c.id, value: c.id }, c.name || c.id);
                })
              )
            ),
            React.createElement("label", { className: "dsm-model-settings-field" },
              t("row.effort"),
              React.createElement("select", {
                className: "dsm-model-settings-select",
                value: effort,
                disabled: !model,
                onChange: function (ev) { teamEffortState[1](ev.target.value); markDirty(); }
              },
                React.createElement("option", { value: "" }, t("row.effortDefault")),
                declared.map(function (c) {
                  return React.createElement("option", { key: c.id, value: c.id }, c.name || c.id);
                })
              )
            )
          ),
          teamWarning === null ? null : React.createElement("div", {
            className: "dsm-model-settings-warn",
            role: "status",
            "data-effort-warning": teamWarning.key
          }, t(teamWarning.key, teamWarning.params)),
          React.createElement("div", { className: "dsm-inject-route-hint" }, t("row.teamModelHint"))
        );
      }

      // ── plugin exemption card ─────────────────────────────────────────────
      // Interaction follows the standard rules-list pattern (Gmail/Apple Mail
      // rule builders, NN/g progressive disclosure): saved rules render as
      // READ-ONLY sentences; editing happens in ONE inline editor at a time
      // with its own draft (取消 discards it, 保存规则 writes it in); the
      // optional birth model sits behind a checkbox; deletion needs a second
      // confirming click; the empty state carries a single CTA.
      function renderExemptCard() {
        var rules = exemptRulesState[0];
        var editor = exemptEditorState[0];
        var armed = exemptArmState[0];
        function matchName(match) {
          if (match === "preset") return t("row.exemptMatchPreset");
          if (match === "cwd") return t("row.exemptMatchCwd");
          return t("row.exemptMatchLabel");
        }
        function groupFor(provider) {
          var groups = groupsState[0];
          for (var gi = 0; gi < groups.length; gi++) {
            if (groups[gi].id === provider) return groups[gi];
          }
          return null;
        }
        function modelDisplay(rule) {
          var group = groupFor(rule.provider);
          var models = group ? group.models || [] : [];
          for (var mi = 0; mi < models.length; mi++) {
            if (models[mi].id === rule.model) return models[mi].name || rule.model;
          }
          return rule.model;
        }
        function pinChoices(rule) {
          var provider = rule.provider || "";
          var group = groupFor(provider);
          var pChoices = groupsState[0].slice();
          if (provider && !group) pChoices.unshift({ id: provider, name: provider });
          var mChoices = group ? (group.models || []).slice() : [];
          if (rule.model && !mChoices.some(function (c) { return c.id === rule.model; })) {
            mChoices.unshift({ id: rule.model, name: rule.model });
          }
          return { provider: provider, pChoices: pChoices, mChoices: mChoices };
        }
        function effortChoices(rule, mChoices) {
          var selectedM = null;
          for (var mi = 0; mi < mChoices.length; mi++) {
            if (mChoices[mi].id === rule.model) { selectedM = mChoices[mi]; break; }
          }
          var declared = selectedM && selectedM.reasoning && Array.isArray(selectedM.reasoning.efforts)
            ? selectedM.reasoning.efforts.slice()
            : [];
          if (rule.effort && !declared.some(function (c) { return c.id === rule.effort; })) {
            declared.unshift({ id: rule.effort, name: rule.effort });
          }
          return declared;
        }
        function exemptSentence(rule) {
          return React.createElement("span", { className: "dsm-exempt-sentence" },
            t("row.exemptWhen") + " ",
            React.createElement("strong", null, matchName(rule.match)),
            " " + t("row.exemptPrefixIs") + " ",
            React.createElement("code", { className: "dsm-exempt-prefix" }, rule.pattern),
            React.createElement("span", { className: "dsm-exempt-arrow" }, " → "),
            rule.provider && rule.model
              ? React.createElement("span", null,
                  React.createElement("strong", null, t("row.exemptBirthUse")),
                  " ",
                  React.createElement("strong", null, modelDisplay(rule)),
                  rule.effort ? " · " + rule.effort : null)
              : React.createElement("strong", null, t("row.exemptNoPin"))
          );
        }
        function renderPinRow(rule, onField) {
          var choices = pinChoices(rule);
          var declared = effortChoices(rule, choices.mChoices);
          return React.createElement("div", { className: "dsm-exempt-pin-row" },
            React.createElement("label", { className: "dsm-model-settings-field" },
              t("row.exemptBirth"),
              React.createElement("select", {
                className: "dsm-model-settings-select",
                value: choices.provider,
                onChange: function (ev) { onField("provider", ev.target.value); }
              },
                React.createElement("option", { value: "" }, t("row.exemptBirthDefault")),
                choices.pChoices.map(function (c) {
                  return React.createElement("option", { key: c.id, value: c.id }, c.name + " (" + c.id + ")");
                })
              )
            ),
            React.createElement("label", { className: "dsm-model-settings-field" },
              t("row.model"),
              React.createElement("select", {
                className: "dsm-model-settings-select",
                value: rule.model || "",
                disabled: !choices.provider,
                onChange: function (ev) { onField("model", ev.target.value); }
              },
                React.createElement("option", { value: "" }, t("row.exemptBirthDefault")),
                choices.mChoices.map(function (c) {
                  return React.createElement("option", { key: c.id, value: c.id }, c.name || c.id);
                })
              )
            ),
            React.createElement("label", { className: "dsm-model-settings-field" },
              t("row.effort"),
              React.createElement("select", {
                className: "dsm-model-settings-select",
                value: rule.effort || "",
                disabled: !rule.model,
                onChange: function (ev) { onField("effort", ev.target.value); }
              },
                React.createElement("option", { value: "" }, t("row.effortDefault")),
                declared.map(function (c) {
                  return React.createElement("option", { key: c.id, value: c.id }, c.name || c.id);
                })
              )
            )
          );
        }
        var editorBody = null;
        if (editor !== null) {
          var draft = editor.draft;
          var pinOn = editor.pin === true;
          var draftIncomplete = exemptDraftIncomplete(draft, pinOn);
          var effortWarning = pinOn && draft.provider && draft.model
            ? checkEffortSupport({ provider: draft.provider, model: draft.model, reasoningEffort: draft.effort || "" }, groupsState[0])
            : null;
          editorBody = React.createElement("div", { className: "dsm-exempt-editor" },
            React.createElement("div", { className: "dsm-exempt-editor-grid" },
              React.createElement("span", { className: "dsm-exempt-connective" }, t("row.exemptWhen")),
              React.createElement("select", {
                className: "dsm-model-settings-select",
                value: draft.match || "label",
                "aria-label": t("row.exemptMatchLabel"),
                onChange: function (ev) { updateExemptDraft("match", ev.target.value); }
              },
                React.createElement("option", { value: "label" }, t("row.exemptMatchLabel")),
                React.createElement("option", { value: "preset" }, t("row.exemptMatchPreset")),
                React.createElement("option", { value: "cwd" }, t("row.exemptMatchCwd"))
              ),
              React.createElement("span", { className: "dsm-exempt-connective" }, t("row.exemptPrefixIs")),
              React.createElement("input", {
                className: "dsm-model-settings-input",
                value: draft.pattern || "",
                placeholder: t("row.exemptPrefixPh"),
                "aria-label": t("row.exemptPrefixIs"),
                onChange: function (ev) { updateExemptDraft("pattern", ev.target.value); }
              })
            ),
            exemptCandidatesState[0].length > 0
              ? React.createElement("label", { className: "dsm-model-settings-field" },
                  t("row.exemptPick"),
                  React.createElement("select", {
                    className: "dsm-model-settings-select",
                    value: "",
                    "aria-label": t("row.exemptPick"),
                    onChange: function (ev) {
                      var picked = exemptCandidatesState[0][Number(ev.target.value)];
                      if (!picked) return;
                      updateExemptDraft("match", picked.kind === "preset" || picked.kind === "cwd" ? picked.kind : "label");
                      updateExemptDraft("pattern", picked.value || "");
                    }
                  },
                    React.createElement("option", { value: "" }, t("row.exemptPickPh")),
                    exemptCandidatesState[0].map(function (item, i) {
                      var kindKey = item.kind === "preset" ? "row.exemptMatchPreset" : item.kind === "cwd" ? "row.exemptMatchCwd" : "row.exemptMatchLabel";
                      return React.createElement("option", { key: item.kind + "|" + item.value, value: String(i) },
                        t(kindKey) + " · " + item.value + " ×" + (item.count || 1));
                    })
                  )
                )
              : null,
            React.createElement("label", { className: "dsm-model-settings-field" },
              t("row.exemptName"),
              React.createElement("input", {
                className: "dsm-model-settings-input",
                value: draft.name || "",
                placeholder: t("row.exemptNamePh"),
                onChange: function (ev) { updateExemptDraft("name", ev.target.value); }
              })
            ),
            React.createElement("label", { className: "dsm-exempt-pin-toggle" },
              React.createElement("input", {
                type: "checkbox",
                checked: pinOn,
                onChange: function (ev) { toggleExemptPin(ev.target.checked); }
              }),
              t("row.exemptPinToggle")
            ),
            pinOn ? renderPinRow(draft, updateExemptDraft) : null,
            draftIncomplete
              ? React.createElement("div", { className: "dsm-model-settings-warn", role: "status" }, t("row.exemptEditorError"))
              : (effortWarning === null ? null : React.createElement("div", {
                  className: "dsm-model-settings-warn",
                  role: "status",
                  "data-effort-warning": effortWarning.key
                }, t(effortWarning.key, effortWarning.params))),
            React.createElement("div", { className: "dsm-exempt-editor-footer" },
              React.createElement("button", {
                type: "button",
                className: "dsm-btn dsm-btn-outline",
                onClick: function () { closeExemptEditor(); }
              }, t("row.exemptRuleCancel")),
              React.createElement("button", {
                type: "button",
                className: "dsm-btn dsm-btn-primary",
                disabled: draftIncomplete,
                title: draftIncomplete ? t("row.exemptEditorError") : "",
                onClick: function () { applyExemptDraft(); }
              }, t("row.exemptRuleSave"))
            )
          );
        }
        var listBody = rules.length === 0
          ? React.createElement("div", { className: "dsm-exempt-empty" },
              React.createElement("span", null, t("row.exemptEmpty")),
              editor === null ? React.createElement("button", {
                type: "button",
                className: "dsm-btn dsm-btn-primary",
                onClick: function () { openExemptEditor(-1); }
              }, t("row.exemptAdd")) : null)
          : React.createElement("ul", { className: "dsm-exempt-list" },
              rules.map(function (rule, index) {
                return React.createElement("li", { key: "exempt-" + index, className: "dsm-exempt-row" },
                  rule.name ? React.createElement("span", { className: "dsm-exempt-row-name", title: rule.name }, rule.name) : null,
                  exemptSentence(rule),
                  React.createElement("div", { className: "dsm-exempt-actions" },
                    React.createElement("button", {
                      type: "button",
                      className: "dsm-model-settings-remove",
                      "aria-label": t("row.exemptEdit"),
                      title: t("row.exemptEdit"),
                      onClick: function () { openExemptEditor(index); }
                    }, "✎"),
                    armed === index
                      ? React.createElement("button", {
                          type: "button",
                          className: "dsm-model-settings-remove dsm-exempt-armed",
                          "aria-label": t("row.exemptConfirm"),
                          onClick: function () { removeExemptRule(index); }
                        }, t("row.exemptConfirm"))
                      : React.createElement("button", {
                          type: "button",
                          className: "dsm-model-settings-remove",
                          "aria-label": t("row.exemptRemove"),
                          title: t("row.exemptRemove"),
                          onClick: function () { armExemptDelete(index); }
                        }, "✕")
                  )
                );
              })
            );
        return React.createElement("div", {
          className: "dsm-exempt-card",
          style: {
            background: "rgba(255, 255, 255, 0.03)",
            border: "1px solid rgba(255, 255, 255, 0.08)",
            borderRadius: "8px",
            padding: "12px",
            marginBottom: "10px"
          }
        },
          React.createElement("div", { style: { display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "10px", marginBottom: "8px" } },
            React.createElement("div", null,
              React.createElement("div", { style: { fontWeight: "600", fontSize: "13px", marginBottom: "4px" } }, t("row.exemptTitle")),
              React.createElement("div", { style: { fontSize: "12px", opacity: 0.7 } }, t("row.exemptDesc"))
            ),
            rules.length > 0 && editor === null
              ? React.createElement("button", {
                  type: "button",
                  className: "dsm-btn dsm-btn-outline",
                  style: { flex: "none" },
                  onClick: function () { openExemptEditor(-1); }
                }, "+ " + t("row.exemptAdd"))
              : null
          ),
          editorBody,
          listBody,
          React.createElement("div", { className: "dsm-inject-route-hint" }, t("row.exemptHint"))
        );
      }

      var diagnostics = typeof props.diagnostics === "function" ? props.diagnostics() : null;
      var diagnosticText = "";
      if (diagnostics) {
        // Always rendered while the save failure is under triage: a ready and
        // writable scope used to hide this row exactly when the interesting
        // failures started. The `build` marker identifies WHICH client bundle is
        // running (the page may be serving a stale one), and `rev` is the
        // mirror revision the next save will be fenced against.
        diagnosticText = "[diag " + DSM_CLIENT_BUILD + "] mirror=" + String(diagnostics.mirrorStatus)
          + " · view.ns=" + String(diagnostics.viewNamespaces)
          + " · bound=" + (diagnostics.bound === null ? "null" : diagnostics.bound)
          + " · candidates=[" + (diagnostics.candidates || []).join(", ") + "]"
          + " · scope=" + String(diagnostics.scopeStatus)
          + " · writable=" + String(diagnostics.writable)
          + " · rev=" + (diagnostics.revision === null || diagnostics.revision === void 0 ? "?" : String(diagnostics.revision));
      }
      return React.createElement("section", { className: "dsm-model-settings" },
        diagnosticText ? React.createElement("div", {
          className: "dsm-model-settings-hint",
          "data-bindings-diag": diagnosticText
        }, diagnosticText) : null,
        // An empty catalog is the cause of "the model cannot be selected": the
        // Provider select then offers only "inherit" and the Model select is
        // disabled behind `!route.provider`. Say so instead of showing a select
        // with nothing in it.
        groupsState[0].length === 0 ? React.createElement("div", {
          className: "dsm-model-settings-hint",
          role: "status",
          "data-catalog-empty": "1"
        }, t("row.catalogEmpty")) : null,
        React.createElement("div", {
          style: {
            borderTop: "1px solid rgba(255, 255, 255, 0.08)",
            paddingTop: "12px",
            marginTop: "12px"
          }
        },
          React.createElement("div", { style: { fontWeight: "600", fontSize: "14px", marginBottom: "4px" } }, "基础默认模型池（未指定具体角色时兜底使用）"),
          React.createElement("div", { style: { fontSize: "12px", opacity: 0.7, marginBottom: "8px" } }, "当未启用 3 角色模式或发起的子任务不属于探索/规划时，按此模型列表与轮询策略执行："),
          React.createElement("div", { style: { fontSize: "12px", opacity: 0.55, marginBottom: "8px" } }, "宿主原生的「允许子代理自选模型」白名单会自动同步成这里配置的全部模型（含 3 个角色池与团队成员模型），不需要再手填第二份名单；不在此页的模型，子代理永远选不到。")
        ),
        routes.length ? React.createElement("div", { className: "dsm-model-settings-list" }, routes) : React.createElement("div", { className: "dsm-model-settings-hint" }, t("row.empty")),
        React.createElement("div", { className: "dsm-model-settings-options" },
          React.createElement("button", { type: "button", className: "dsm-btn dsm-btn-outline", onClick: addRoute }, t("row.add")),
          routes.length > 1 ? React.createElement("div", { className: "dsm-model-settings-strategy" },
            React.createElement("span", null, t("row.strategy")),
            React.createElement("select", {
              className: "dsm-model-settings-select",
              value: strategyState[0],
              onChange: function (event) { strategyState[1](event.target.value); savedState[1](false); saveErrorState[1](null); dirtyState[1](true); }
            },
              React.createElement("option", { value: "round-robin" }, t("row.roundRobin")),
              React.createElement("option", { value: "random" }, t("row.random"))
            )
          ) : null
        ),
        React.createElement("label", { className: "dsm-model-settings-failover" },
          React.createElement("input", {
            type: "checkbox",
            checked: failoverEnabledState[0],
            onChange: function (event) { failoverEnabledState[1](event.target.checked); savedState[1](false); saveErrorState[1](null); dirtyState[1](true); }
          }),
          React.createElement("span", null, t("row.failoverEnabled")),
          React.createElement("span", { className: "dsm-failover-hint" }, t("row.failoverHint"))
        ),
        // Tell the subagent which route it is on, by putting one line into its
        // OWN context (a real prompt injection, unlike the display-only rows).
        React.createElement("label", { className: "dsm-model-settings-inject-route" },
          React.createElement("input", {
            type: "checkbox",
            checked: injectRouteContextState[0],
            onChange: function (event) { injectRouteContextState[1](event.target.checked); savedState[1](false); saveErrorState[1](null); dirtyState[1](true); }
          }),
          React.createElement("span", null, t("row.injectRouteContext")),
          React.createElement("span", { className: "dsm-inject-route-hint" }, t("row.injectRouteContextHint"))
        ),
        React.createElement("label", { className: "dsm-model-settings-inject-route" },
          React.createElement("input", {
            type: "checkbox",
            checked: showChatModelNoticeState[0],
            onChange: function (event) { showChatModelNoticeState[1](event.target.checked); savedState[1](false); saveErrorState[1](null); dirtyState[1](true); }
          }),
          React.createElement("span", null, t("row.showChatModelNotice")),
          React.createElement("span", { className: "dsm-inject-route-hint" }, t("row.showChatModelNoticeHint"))
        ),
        // The header critters switch. Same checkbox row as the notice above so
        // the two display-only toggles sit together; flipping it takes effect
        // on the next poll tick (<= 1.2s) without touching the slot registry.
        React.createElement("label", { className: "dsm-model-settings-inject-route" },
          React.createElement("input", {
            type: "checkbox",
            checked: showHeaderCrittersState[0],
            onChange: function (event) {
              var on = event.target.checked;
              showHeaderCrittersState[1](on);
              updateCrittersEnabled(on);
              savedState[1](false);
              saveErrorState[1](null);
              dirtyState[1](true);
            }
          }),
          React.createElement("span", null, t("row.showHeaderCritters")),
          React.createElement("span", { className: "dsm-inject-route-hint" }, t("row.showHeaderCrittersHint"))
        ),
        
        React.createElement("div", {
          style: {
            display: "flex",
            alignItems: "center",
            gap: "8px",
            flexWrap: "wrap",
            padding: "2px 0"
          }
        },
          React.createElement("label", { className: "dsm-model-settings-inject-route" },
            React.createElement("input", {
              type: "checkbox",
              checked: forkWindowSlicingState[0],
              onChange: function (event) { forkWindowSlicingState[1](event.target.checked); savedState[1](false); saveErrorState[1](null); dirtyState[1](true); }
            }),
            React.createElement("span", null, t("row.forkWindowSlicing")),
            React.createElement("span", { className: "dsm-inject-route-hint" }, t("row.forkWindowSlicingHint"))
          ),
          forkWindowSlicingState[0] ? React.createElement("div", {
            style: {
              display: "inline-flex",
              alignItems: "center",
              gap: "6px",
              marginLeft: "18px",
              fontSize: "12px",
              color: "var(--dsw-alias-label-secondary,#b8b8b8)"
            }
          },
            React.createElement("span", null, t("row.forkWindowTurns") + ":"),
            React.createElement("input", {
              type: "number",
              min: 1,
              max: 20,
              value: forkWindowTurnsState[0],
              onChange: function (event) {
                var val = parseInt(event.target.value, 10);
                forkWindowTurnsState[1](isNaN(val) ? 3 : Math.max(1, Math.min(20, val)));
                savedState[1](false);
                saveErrorState[1](null);
                dirtyState[1](true);
              },
              style: {
                width: "48px",
                height: "22px",
                padding: "0 6px",
                borderRadius: "6px",
                border: "1px solid var(--dsw-alias-border-l2,#36373b)",
                background: "var(--dsw-alias-bg-layer-2,#232529)",
                color: "var(--dsw-alias-label-primary,#e6e6e6)",
                fontSize: "12px"
              }
            }),
            React.createElement("span", { className: "dsm-inject-route-hint" }, t("row.forkWindowTurnsHint"))
          ) : null
        ),
        
        React.createElement("div", {
          style: {
            borderTop: "1px solid rgba(255, 255, 255, 0.08)",
            paddingTop: "12px",
            marginTop: "6px"
          }
        },
          React.createElement("label", {
            className: "dsm-model-settings-inject-route",
            style: { fontWeight: "600" }
          },
            React.createElement("input", {
              type: "checkbox",
              checked: roleModeState[0],
              onChange: function (event) {
                roleModeState[1](event.target.checked);
                savedState[1](false);
                saveErrorState[1](null);
                dirtyState[1](true);
              }
            }),
            React.createElement("span", null, t("row.roleMode")),
            React.createElement("span", { className: "dsm-inject-route-hint" }, t("row.roleModeHint"))
          ),
          roleModeState[0] ? React.createElement("div", { style: { marginTop: "10px" } },
            renderRoleCard(t("row.roleExplore"), t("row.roleDescExplore"), exploreRoutesState),
            renderRoleCard(t("row.rolePlan"), t("row.roleDescPlan"), planRoutesState),
            renderRoleCard(t("row.rolePatch"), t("row.roleDescPatch"), patchRoutesState),
            // Cooldown after a failure. 0 means "do not cool down": failures
            // still fall through to the next candidate, they just do not remove
            // the failed model from later rotations.
            React.createElement("div", {
              style: {
                display: "flex",
                alignItems: "center",
                gap: "6px",
                flexWrap: "wrap",
                padding: "2px 0",
                fontSize: "12px",
                color: "var(--dsw-alias-label-secondary,#b8b8b8)"
              }
            },
              React.createElement("span", null, t("row.cooldownSeconds") + ":"),
              React.createElement("input", {
                type: "number",
                min: 0,
                max: 3600,
                value: roleCooldownState[0],
                onChange: function (event) {
                  var val = parseInt(event.target.value, 10);
                  roleCooldownState[1](isNaN(val) ? 15 : Math.max(0, Math.min(3600, val)));
                  markDirty();
                },
                style: {
                  width: "64px",
                  height: "22px",
                  padding: "0 6px",
                  borderRadius: "6px",
                  border: "1px solid var(--dsw-alias-border-l2,#36373b)",
                  background: "var(--dsw-alias-bg-layer-2,#232529)",
                  color: "var(--dsw-alias-label-primary,#e6e6e6)",
                  fontSize: "12px"
                }
              }),
              React.createElement("span", { className: "dsm-inject-route-hint" }, t("row.cooldownSecondsHint"))
            )
          ) : null
        ),

        renderTeamModelCard(),
        renderExemptCard(),

        (hasIncompleteRoute || hasIncompleteRoleRoute || hasIncompleteExempt) ? React.createElement("div", { className: "dsm-model-settings-hint" }, t("row.incomplete")) : null,
        effortWarnings.length === 0 ? null : React.createElement("div", {
          className: "dsm-model-settings-warn-list",
          role: "status",
          "data-effort-warning-count": String(effortWarnings.length)
        }, effortWarnings.map(function (entry) {
          return React.createElement("div", { key: entry.key + ":" + entry.index }, t(entry.warning.key, entry.warning.params));
        })),
        // Save outcome. The success half was already surfaced as a toast; the
        // FAILURE half used to be written to state nobody rendered, so a refused
        // write looked like a dead button. The value is the write's own message:
        // either a transport/refusal error, or `notApplied:<scopeStatus>:writable=…`
        // a write that was accepted but the stored document did not change — the
        // latter names the exact scope state, which is what makes the report
        // actionable rather than a generic refusal.
        saveErrorState[0] ? React.createElement("div", {
          className: "dsm-model-settings-footer-error",
          role: "alert",
          "data-settings-save-error": String(saveErrorState[0])
        }, String(saveErrorState[0]).indexOf("notApplied:") === 0
          ? t("row.settingsUnavailable", { message: String(saveErrorState[0]) })
          : t("row.saveFailed", { message: String(saveErrorState[0]) })) : null,
        savedState[0] ? React.createElement("div", {
          className: "dsm-model-settings-footer-status",
          role: "status",
          "data-settings-save-status": "saved"
        }, t("row.saved")) : null,
        React.createElement("div", { className: "dsm-model-settings-footer" },
          React.createElement("div", { className: "dsm-model-settings-footer-left" },
            React.createElement("a", {
              className: "dsm-model-settings-cheer",
              href: DSM_GITHUB_URL,
              target: "_blank",
              rel: "noopener noreferrer"
            },
              t("row.cheer"),
              React.createElement("span", { className: "dsm-model-settings-cheer-star", "aria-hidden": "true" }, "\u2605")
            )
          ),
          React.createElement("button", { type: "button", className: "dsm-btn dsm-btn-outline", disabled: discardDisabled, onClick: discard }, t("row.discard")),
          React.createElement("button", { type: "button", className: "dsm-btn dsm-btn-primary", disabled: saveDisabled, onClick: save }, busyState[0] ? t("row.saving") : t("row.save"))
        ),
        toastState[0] ? React.createElement(Toast, { key: toastState[0].seq, text: toastState[0].text, onDone: function () { toastState[1](null); } }) : null
      );
    }

    // ── SubagentModelCard: collapsible card shell (default collapsed) ─────
    function SubagentModelCard(props) {
      // Family pattern (dsh-ldvh / dsh-connect-workbuddy / dsh-sub-cli): on the
      // Plugins page a card is asked for `view: 'summary'` (a one-line glance)
      // or `view: 'page'` (the form itself). Only the page form should default
      // to open — collapsing a summary keeps the list scannable, while an
      // unopened page form hides the settings the user came for.
      if (props.view === "summary") return props.t("row.desc");
      var openState = React.useState(props.view === "page");
      var open = openState[0];
      var setOpen = openState[1];

      var t = props.t;
      var title = t("row.title");
      var description = t("row.desc");
      return React.createElement("li", { className: "dsm-plugin-card" + (open ? " dsm-plugin-card-open" : "") },
        React.createElement("button", {
          type: "button",
          className: "dsm-plugin-card-header",
          "aria-expanded": open,
          "aria-label": t(open ? "row.collapse" : "row.expand") + ": " + title,
          onClick: function () { setOpen(!open); }
        },
          React.createElement("img", { className: "dsm-plugin-card-icon", src: DSM_ICON, alt: "" }),
          React.createElement("span", { className: "dsm-plugin-card-head" },
            React.createElement("span", { className: "dsm-plugin-card-title" }, title),
            React.createElement("span", { className: "dsm-plugin-card-description" }, description)
          ),
          React.createElement("span", { className: "dsm-plugin-card-chevron" + (open ? " dsm-plugin-card-chevron-open" : "") }, IconChevronDown ? React.createElement(IconChevronDown, { size: 14 }) : React.createElement("span", { className: "dsm-plugin-card-caret" }, "▾"))
        ),
        React.createElement("div", { className: "dsm-plugin-card-body", hidden: !open },
          React.createElement(SubagentModelRow, props)
        )
      );
    }

    // ── 对话流注入行的渲染器（自有节点 kind）─────────────────────────────
    //
    // 宿主按 `entryKey = node.kind` 在 `conversation.chat.node` 槽位**运行时分派**
    // 渲染器（`ChatNodeSeat` 传 `entryKey: routedNode.kind`）。该分派是 keyed 槽位：
    // 没有占用者的 kind 走 `ChatNodeSeat` 传入的 `fallback`——一个 `JsonBlock`
    // （标签 "unknown surface" + 节点数据原样 JSON）。所以只改 kind 而不注册渲染器
    // 不是「行消失」，而是**对话流里出现一行原始 JSON**（比不可见更糟）。
    //
    // 渲染器收到的是 `{ node }`（`ChatNodeOwnerProps`），节点数据即 `start()` 的
    // state（`buildViewNode` 把它放进 `data`）。这里只读 content / source.summary，
    // 不依赖任何宿主内部工具。
    function SubagentModelNoticeRow(props) {
      if (!isNoticeEnabled()) return null;
      var node = props.node;
      var data = node && node.data ? node.data : {};
      // `t` is the framework-injected locale seat: this registration declares
      // `locale:`, so the renderer receives it. Keep the label in the
      // dictionary rather than inlining one language (the plugin ships zh+en).
      var t = props.t || function (key) { return key; };
      var openState = React.useState(false);
      var open = openState[0];
      var setOpen = openState[1];
      var blocks = Array.isArray(data.content) ? data.content : [];
      var text = blocks.map(function (block) {
        return block && typeof block.text === "string" ? block.text : "";
      }).join("\n");
      var summary = data.source && typeof data.source.summary === "string" ? data.source.summary : "";
      return React.createElement("div", { className: "dsm-notice-row" },
        React.createElement("button", {
          type: "button",
          className: "dsm-notice-toggle",
          "aria-expanded": open,
          onClick: function () { setOpen(!open); }
        },
          React.createElement("span", { className: "dsm-notice-dot", "aria-hidden": "true" }),
          React.createElement("span", { className: "dsm-notice-label" }, t("row.noticeLabel")),
          summary ? React.createElement("span", { className: "dsm-notice-summary" }, summary) : null
        ),
        open ? React.createElement("pre", { className: "dsm-notice-body" }, text) : null
      );
    }

    /** 注册自有 kind 的渲染器；返回卸载函数。槽位缺失时静默跳过。 */
    function registerSubagentModelNotice(ctx) {
      try {
        var regOff = null;
        var injectOff = ctx.slots.inject("conversation.chat.node", function () {
          regOff = ctx.slots.register({
            name: "conversation.chat.node",
            key: CHAT_MODEL_NODE_KIND,
            locale: SUBAGENT_ROW_LOCALE
          }, SubagentModelNoticeRow);
          return regOff;
        });
        return function () {
          if (typeof regOff === "function") {
            try { regOff(); } catch (_e) {}
          }
          if (typeof injectOff === "function") {
            try { injectOff(); } catch (_e) {}
          }
        };
      } catch (error) {
        console.error("[dsh-subagent-role-router] notice renderer failed to register (chat row absent):", error);
        return function () { };
      }
    }

    // ── live route picker: change a RUNNING subagent's model / effort ────
    //
    // Renders in the subagent conversation header (`conversation.session.header
    // .actions` is a `list` slot; the host hands a session-scoped registration
    // `sessionId`, `useSessions`, `useStatus` and the bound `t`).
    //
    // WHY NOT REUSE THE OFFICIAL DROPDOWN: `@deepseek-ai/dsh-client-ui-model-
    // selection` refuses subagent sessions on purpose — its `available` is
    // `sessions.subagentAddress(sessionId) === void 0`, the component `return
    // null`s when that is false, and `select()` throws "model selection is
    // unavailable for addressed subagent sessions". The Host RPC behind it
    // (`session/selectModel`) refuses too (`session/agent-busy`). So the
    // official control cannot be enabled from here; this plugin owns a private
    // loopback route instead (`/subagent-role-router`, see the host half) and applies
    // the pick in its own `agent/request` waterfall listener.
    // UPDATE (2026-10-25): the selection shim below now lifts that client-side
    // gate and reroutes `selectModel` for subagent sessions through the same
    // endpoint, so theme/redrawn seats DO work — this picker remains as the
    // fallback for hosts where the shim cannot install or no theme is active.
    //
    // The pick is applied on the NEXT request of that child, not retroactively:
    // a request already in flight keeps the route it started on.
    var LIVE_ROUTE_PATH = "subagent-role-router";

    /** Envelope-tolerant fetch: returns the decoded body or `null`, never throws. */
    function liveRouteRequest(path, init) {
      if (typeof fetch !== "function") return Promise.resolve(null);
      var pending;
      try {
        pending = fetch(path, init);
      } catch (_e) {
        return Promise.resolve(null);
      }
      return pending.then(function (response) {
        if (!response || typeof response.json !== "function") return null;
        return response.json().then(function (body) {
          return body !== null && typeof body === "object" ? body : null;
        }, function () { return null; });
      }, function () { return null; });
    }

    function liveRouteGet(childId) {
      return liveRouteRequest(
        LIVE_ROUTE_PATH + "/route?childId=" + encodeURIComponent(childId),
        { method: "GET" }
      );
    }

    function liveRoutePost(action, payload) {
      return liveRouteRequest(LIVE_ROUTE_PATH + "/" + action, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload)
      });
    }

    function exemptCandidatesGet() {
      return liveRouteRequest(LIVE_ROUTE_PATH + "/exempt-candidates", { method: "GET" });
    }

    // 批量接口：查询走 GET，写入/清除走 POST。路径全部挂在同一个 handler 下，
    // 于是 loopback 403、application/json 415、8KB body 上限这些闸门自动继承，
    // 不需要在这里再实现一遍。
    function batchFetch(parentSessionId) {
      if (typeof parentSessionId !== "string" || parentSessionId === "") return Promise.resolve(null);
      return liveRouteRequest(
        BATCH_PATH + "?parentSessionId=" + encodeURIComponent(parentSessionId),
        { method: "GET" }
      );
    }

    function batchPost(kind, payload) {
      return liveRouteRequest(BATCH_PATH + "/" + kind, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload)
      });
    }

    // ── selection shim: make ANY model seat work on subagent pages ─────────
    //
    // The host model-selection module refuses subagent sessions CLIENT-side
    // (`assertAvailable()` throws before any RPC), and the Host RPC behind it
    // refuses too (`session/agent-busy`). Theme-redrawn seats click silently
    // because they swallow that throw — which is why a second, working control
    // (LiveRoutePicker) used to coexist with the dead one.
    //
    // Two guarded patches reroute that exact path through this plugin's
    // loopback endpoint instead:
    //   1. `ModelDirectory.prototype.assertAvailable` → no-op (the client gate
    //      only; render-level availability of the host seat is untouched).
    //   2. `sessions.selectModel` → subagent-targeted calls go to
    //      POST subagent-role-router/select, everything else passes through.
    // While BOTH are up, LiveRoutePicker hides itself and the theme's own seat
    // becomes the single functional control. If either patch cannot install
    // (module renamed, service absent), the picker falls back to visible.
    var LIVE_SHIM = { installed: false };

    /**
     * The model the user picked for a child session, keyed by session id.
     *
     * A child session owns no durable `model/selection` event, so the host
     * builds its ModelDirectory from the catalog every time the pane reopens:
     * a fresh instance starts at `current === catalog default`. A switch that
     * only lived on the directory INSTANCE therefore looks like it "bounces
     * back" to the default the moment anything rebuilds or re-syncs it. The
     * pick is recorded here instead — outside any instance — and every later
     * directory is seeded from it before its first paint.
     */
    var PICKED_BY_SESSION = {};
    var PICKED_ORDER = [];
    var PICKED_LIMIT = 60;

    /** Normalize a selection to `{provider, model, reasoningEffort}`, or null. */
    function selectionKey(selection) {
      if (!selection || typeof selection !== "object") return null;
      var provider = selection.provider;
      var model = selection.model;
      if (typeof provider !== "string" || provider === "") return null;
      if (typeof model !== "string" || model === "") return null;
      return { provider: provider, model: model, reasoningEffort: selection.reasoningEffort };
    }

    /** Record the pick for one child session under every id spelling. */
    function rememberPicked(sessionId, selection) {
      var key = selectionKey(selection);
      if (!key || typeof sessionId !== "string" || sessionId === "") return null;
      var stripped = sessionId.indexOf("session-") === 0 ? sessionId.slice(8) : sessionId;
      PICKED_BY_SESSION[sessionId] = key;
      PICKED_BY_SESSION[stripped] = key;
      PICKED_BY_SESSION["session-" + stripped] = key;
      if (PICKED_ORDER.indexOf(stripped) === -1) PICKED_ORDER.push(stripped);
      while (PICKED_ORDER.length > PICKED_LIMIT) {
        var dropped = PICKED_ORDER.shift();
        delete PICKED_BY_SESSION[dropped];
        delete PICKED_BY_SESSION["session-" + dropped];
      }
      return key;
    }

    /** The recorded pick for a session, or null. */
    function pickedFor(sessionId) {
      if (typeof sessionId !== "string" || sessionId === "") return null;
      return PICKED_BY_SESSION[sessionId] || null;
    }

    /** Drop the recorded pick (explicit reset back to the inherited model). */
    function forgetPicked(sessionId) {
      if (typeof sessionId !== "string" || sessionId === "") return;
      var stripped = sessionId.indexOf("session-") === 0 ? sessionId.slice(8) : sessionId;
      delete PICKED_BY_SESSION[sessionId];
      delete PICKED_BY_SESSION[stripped];
      delete PICKED_BY_SESSION["session-" + stripped];
      var at = PICKED_ORDER.indexOf(stripped);
      if (at !== -1) PICKED_ORDER.splice(at, 1);
    }

    /**
     * The plugin's own cordis context, captured in apply().
     *
     * Helpers that run OUTSIDE apply (the picker's render path, the shim's late
     * probes) need the same services apply sees. They used to reference a bare
     * `ctx`, which is not in scope at module level: `typeof ctx` evaluates to
     * "undefined" without throwing, so every one of those lookups silently
     * failed — no session id resolved, no child detected, no control rendered.
     */
    var pluginCtx = null;

    /**
     * Stop fallback for subagent pages.
     *
     * The composer's stop button cancels a child through the host's
     * `interruptByParent`, which looks the child up in the resident-activation
     * table and RETURNS SILENTLY when it is not there. The UI then reports
     * "accepted" while the child keeps running: the button looks broken and
     * nothing explains it. Wrap `cancel` so every stop is measured: if the
     * child is still running a moment later, ask this plugin's endpoint to
     * interrupt it again through every id form and authority the host accepts.
     */
    var STOP_FALLBACK = { installed: false };

    /**
     * Patch the shared Conversation prototype once.
     *
     * @param {object} [deps] - test seams: sessions, post, sleep, log.
     * @returns {{installed: boolean, dispose: Function}}
     */
    function installStopFallback(deps) {
      var inject = deps || {};
      if (STOP_FALLBACK.installed) return { installed: true, dispose: STOP_FALLBACK.restore || function () {} };
      var sessions = inject.sessions || serviceOf("sessions");
      var post = inject.post || liveRoutePost;
      var sleep = inject.sleep || function (ms) {
        return new Promise(function (resolve) { setTimeout(resolve, ms); });
      };
      var log = inject.log || srrLog;
      if (!sessions || typeof sessions.scope !== "function" || typeof sessions.subagentAddress !== "function") {
        return { installed: false, dispose: function () {} };
      }
      var armed = { proto: null, original: null, originalScope: null, scopeWrapped: false };

      /**
       * Reach the ONE Conversation prototype every session shares and wrap its
       * cancel. Returns true once the prototype is known.
       */
      var patchProto = function (conversation) {
        if (armed.proto !== null) return true;
        if (!conversation || typeof conversation.cancel !== "function") return false;
        var proto = Object.getPrototypeOf(conversation);
        if (proto === null || typeof proto.cancel !== "function") return false;
        armed.proto = proto;
        if (proto.__srrStopPatched === true) return true;
        var original = proto.cancel;
        armed.original = original;
        proto.__srrStopPatched = true;
        proto.cancel = function () {
          var self = this;
          var sessionId = sidOf(self);
          var address;
          try {
            address = sessionId === "" ? undefined : sessions.subagentAddress(sessionId);
          } catch (_e) {
            address = undefined;
          }
          // The host throws on a refused RPC and resolves on an accepted one;
          // an accepted stop that does nothing is exactly the case to catch, so
          // both outcomes are measured the same way.
          var measure = function (result, threw) {
            var ok = result !== null && typeof result === "object" ? result.ok : undefined;
            var code = result && result.error && result.error.code;
            log("STOP_RESULT", { sid: sessionId, ok: ok, code: code, threw: threw === true, mode: address && address.mode, child: address && address.childSessionId, parent: address && address.parentSessionId });
            if (address === undefined) return undefined;
            return sleep(1200).then(function () {
              if (!isRunning(sessionId)) return undefined;
              log("STOP_STILL_RUNNING", { sid: sessionId });
              return Promise.resolve(post("stop", {
                childId: address.childSessionId,
                parentSessionId: address.parentSessionId
              })).then(function (response) {
                log("STOP_FALLBACK", { sid: sessionId, ok: response && response.ok, value: response && response.value });
                return sleep(1200);
              }).then(function () {
                log("STOP_AFTER_FALLBACK", { sid: sessionId, running: isRunning(sessionId) });
              });
            });
          };
          var outcome = original.apply(this, arguments);
          Promise.resolve(outcome).then(function (result) {
            return measure(result, false);
          }, function (error) {
            return measure({ ok: false, error: { code: error && error.code } }, true);
          }).catch(function () {});
          return outcome;
        };
        log("STOP_FALLBACK_INSTALLED", { sid: sidOf(conversation) });
        return true;
      };

      // The Conversation service is per session and does not store the id: it
      // asks the sessions service for the scope tag (the same call cancel uses).
      var sidOf = function (conversation) {
        if (!conversation) return "";
        try {
          if (typeof conversation.scopeId === "function") {
            var tag = conversation.scopeId("cancel");
            if (typeof tag === "string" && tag !== "") return tag;
          }
        } catch (_e) {}
        return typeof conversation.sessionId === "string" ? conversation.sessionId : "";
      };

      /**
       * Session list snapshots are published by more than one store; the
       * running bit lives in the list snapshot, the scopes in the registry.
       */
      var listSnapshots = function () {
        var shapes = [];
        try {
          if (sessions.list && typeof sessions.list.getSnapshot === "function") shapes.push(sessions.list.getSnapshot());
        } catch (_e) {}
        try {
          if (typeof sessions.getSnapshot === "function") shapes.push(sessions.getSnapshot());
        } catch (_e) {}
        return shapes;
      };

      var isRunning = function (sessionId) {
        var shapes = listSnapshots();
        for (var index = 0; index < shapes.length; index += 1) {
          var row = shapes[index] && shapes[index].byId ? shapes[index].byId[sessionId] : undefined;
          if (row !== undefined) return row.running === true;
        }
        return false;
      };

      // Try the ids we can name right now: the caller's session first, then
      // every session the list store knows about.
      var candidates = [];
      if (typeof inject.sessionId === "string" && inject.sessionId !== "") candidates.push(inject.sessionId);
      var shapes = listSnapshots();
      for (var shapeIndex = 0; shapeIndex < shapes.length; shapeIndex += 1) {
        var byId = shapes[shapeIndex] && shapes[shapeIndex].byId;
        if (!byId) continue;
        for (var key in byId) {
          if (Object.prototype.hasOwnProperty.call(byId, key) && candidates.indexOf(key) < 0) candidates.push(key);
        }
      }
      for (var candidateIndex = 0; candidateIndex < candidates.length; candidateIndex += 1) {
        if (armed.proto !== null) break;
        try {
          var scoped = sessions.scope(candidates[candidateIndex]);
          if (scoped && typeof scoped.get === "function") patchProto(scoped.get("conversation"));
        } catch (_e) {}
      }

      // Nothing live yet is normal (apply runs before the first session opens).
      // Arm the registry instead: the host resolves a scope on every render and
      // every send, so the prototype shows up on its own a moment later.
      if (armed.proto === null) {
        try {
          var originalScope = sessions.scope;
          armed.originalScope = originalScope;
          sessions.scope = function () {
            var result = originalScope.apply(this, arguments);
            if (armed.proto === null) {
              try {
                if (result && typeof result.get === "function") patchProto(result.get("conversation"));
              } catch (_e) {}
            }
            return result;
          };
          armed.scopeWrapped = true;
          log("STOP_FALLBACK_ARMED", { candidates: candidates.length });
        } catch (_e) {
          log("STOP_FALLBACK_SKIPPED", { proto: "none", reason: "scope-wrap-failed" });
          return { installed: false, dispose: function () {} };
        }
      }
      if (armed.proto === null && !armed.scopeWrapped) {
        log("STOP_FALLBACK_SKIPPED", { proto: "none", reason: "no-scope" });
        return { installed: false, dispose: function () {} };
      }
      STOP_FALLBACK.installed = true;
      STOP_FALLBACK.restore = function () {
        if (armed.proto !== null && armed.original !== null) {
          armed.proto.cancel = armed.original;
          try { delete armed.proto.__srrStopPatched; } catch (_e) {}
        }
        if (armed.scopeWrapped && armed.originalScope !== null) {
          try { delete sessions.scope; } catch (_e) { sessions.scope = armed.originalScope; }
        }
        STOP_FALLBACK.installed = false;
        STOP_FALLBACK.restore = null;
      };
      return { installed: true, dispose: STOP_FALLBACK.restore };
    }
    /** Read a host service through the captured context, or undefined. */
    function serviceOf(name) {
      try {
        if (pluginCtx && typeof pluginCtx.get === "function") return pluginCtx.get(name);
        return undefined;
      } catch (_e) {
        return undefined;
      }
    }

    /**
     * Claim (or release) the single model control for ONE composer.
     *
     * The CSS shipped with this client keys on `[data-dsm-live-route]` to
     * suppress every other model seat inside that container — the claude-style
     * theme's own seat, and any host seat a future build renders for child
     * sessions. The mark is placed on the nearest composer card containing this
     * picker, NOT on `document.body`: a subagent pane can be open beside its
     * parent conversation, and a document-wide mark would strip the parent's
     * perfectly good seat too. Only when no composer card can be found does the
     * mark fall back to `body`.
     *
     * Returns a restore function; safe to call with no DOM at all.
     */
    function claimModelControl(active, anchor) {
      var node = anchor !== undefined ? anchor : null;
      if (!node || typeof node.closest !== "function") return function () {};
      if (!active) return function () {};
      var el = null;
      try {
        el = node.closest("[data-composer-card]");
      } catch (_eClosest) {}
      if (!el && typeof document !== "undefined") el = document.body;
      if (!el || typeof el.setAttribute !== "function") return function () {};
      var previous = typeof el.getAttribute === "function" ? el.getAttribute("data-dsm-live-route") : null;
      el.setAttribute("data-dsm-live-route", "1");
      return function () {
        try {
          if (previous === null || previous === undefined) {
            if (typeof el.removeAttribute === "function") el.removeAttribute("data-dsm-live-route");
          } else {
            el.setAttribute("data-dsm-live-route", previous);
          }
        } catch (_eRelease) {}
      };
    }

    /**
     * Ask the HOST whether a session belongs to a child agent.
     *
     * This is the same question the host's own model slot asks itself
     * (`sessions.subagentAddress(sessionId) !== void 0`), so answering it the
     * same way keeps the plugin and the host in agreement. The sessions store
     * snapshot is the fallback, for the window where a child is not yet in the
     * address table but is already listed.
     *
     * `sessionsOverride` exists for the shim's tests; production passes nothing.
     */
    function hostSaysSubagent(sessionId, sessionsOverride) {
      if (sessionId === void 0 || sessionId === null || sessionId === "") return false;
      try {
        var sessions = typeof sessionsOverride === "function"
          ? sessionsOverride()
          : serviceOf("sessions");
        if (sessions && typeof sessions.subagentAddress === "function") {
          if (sessions.subagentAddress(sessionId) !== void 0) return true;
          var alt = sessionId.startsWith("session-") ? sessionId.slice(8) : "session-" + sessionId;
          if (sessions.subagentAddress(alt) !== void 0) return true;
        }
        var snapshot = sessions && sessions.list && typeof sessions.list.getSnapshot === "function"
          ? sessions.list.getSnapshot()
          : (sessions && typeof sessions.getSnapshot === "function" ? sessions.getSnapshot() : null);
        if (snapshot && snapshot.byId) {
          var stripped = sessionId.startsWith("session-") ? sessionId.slice(8) : sessionId;
          var summary = snapshot.byId[sessionId] || snapshot.byId[stripped] || snapshot.byId["session-" + stripped];
          if (summary) {
            if (summary.origin === "subagent") return true;
            if (typeof summary.delegationDepth === "number" && summary.delegationDepth > 0) return true;
          }
        }
      } catch (_e) { /* unknown counts as parent: never claim a child we cannot prove */ }
      return false;
    }

    /**
     * Module-level "is this a child session" probe, for code that renders
     * outside `installSelectionShim` (the picker and its diagnostics).
     *
     * It exists because the picker once called a helper of the same name that
     * was only declared INSIDE that installer. That reference threw on the
     * component's very first render, the host's slot error boundary swallowed
     * it into an empty anchor, and the control therefore never mounted — no
     * log, no console line, nothing to see. Every "is it rendering?" probe now
     * sits at module level so that failure mode cannot come back.
     */
    function isSubagentSession(sessionId) {
      return hostSaysSubagent(sessionId);
    }

    /**
     * Install the directoryFor wrap. `deps` exists so tests can inject the
     * resolver lookup, the sessions lookup, the POST path and `sleep`;
     * production leaves it out. Returns a disposer that also cancels pending
     * retry probes.
     */
    function installSelectionShim(ctx, deps) {
      deps = deps || {};
      var disposed = false;
      var disposeFns = [];
      var sleepFn = deps.sleep || function (ms) {
        return new Promise(function (resolve) {
          if (typeof setTimeout !== "function") { resolve(); return; }
          setTimeout(resolve, ms);
        });
      };
      var sessionsOf = deps.sessions || function () {
        return typeof ctx.get === "function" ? ctx.get("sessions") : undefined;
      };
      var selectViaRoute = deps.select || function (request) {
        // Both call sites below pass "childId"; older shapes passed
        // "sessionId". Reading only one of them silently posted undefined, the
        // endpoint answered not-live and the click did nothing at all.
        return liveRoutePost("select", {
          childId: request.childId || request.sessionId,
          provider: request.provider,
          model: request.model,
          reasoningEffort: request.reasoningEffort
        }).then(function (body) {
          if (body && body.ok === true) return { ok: true, value: void 0 };
          var error = body && body.error ? body.error : { code: "subagent-role-router/unreachable", message: "route endpoint unavailable" };
          return { ok: false, error: error };
        });
      };

      // The decisive host facts (read from the installed app bundle):
      // ModelDirectoryResolver.directoryFor builds each directory as
      // `new ModelDirectory(this.ctx.remote.session, sessionId, () =>
      // sessions.subagentAddress(sessionId) === void 0, ...)`, and select()
      // calls `this.sessions.selectModel(...)` — the RPC namespace, NOT the
      // sessions store (the store has no selectModel at all, so a store wrap
      // can never install). Every selection path — the host's own seat, the
      // claude-style theme's seat — resolves through resolver.directoryFor on
      // each interaction. The one robust lever is therefore wrapping
      // directoryFor: lift the class gate on whatever directory comes back and
      // reroute that instance's select() for subagent sessions to the plugin
      // endpoint. Session detection is resolved lazily at call time (the same
      // way the theme resolves its services), so a late-mounted sessions store
      // costs nothing and no method-shape guesswork is involved.
      // The shim keeps its own sessions lookup (tests inject it), but the
      // question itself is answered by hostSaysSubagent so the picker and the
      // shim can never disagree about who is a child.
      var shimSaysSubagent = function (sid) {
        return hostSaysSubagent(sid, sessionsOf);
      };
      var liftProto = function (dir) {
        var proto = dir !== null && dir !== void 0 ? Object.getPrototypeOf(dir) : null;
        if (!proto) return;
        if (typeof proto.assertAvailable === "function" && proto.__srrGateLifted !== true) {
          var originalAssert = proto.assertAvailable;
          proto.assertAvailable = function () { /* gate lifted; routing happens in the select wrap */ };
          proto.__srrGateLifted = true;
          disposeFns.push(function () {
            proto.assertAvailable = originalAssert;
            try { delete proto.__srrGateLifted; } catch (_e) {}
          });
        }
        if (typeof proto.syncInputs === "function" && proto.__srrProtoSyncWrapped !== true) {
          var originalProtoSyncInputs = proto.syncInputs;
          proto.syncInputs = function () {
            originalProtoSyncInputs.apply(this, arguments);
            var self = this;
            var sid = self && self.sessionId;
            var isChild = typeof self.available === "function" ? !self.available() : shimSaysSubagent(sid);
            if (!isChild) return;
            // A child session has no durable model/selection event of its own, so
            // `projected` stays undefined and the host's own sync parks the
            // directory in "loading" forever — that is the permanent
            // "loading models…" label the user sees. The catalog, however, IS
            // loaded (it is shared host-wide), so the directory can be settled
            // here: the pick the user just made wins, otherwise the catalog
            // default does.
            try {
              var catalogState = self.catalog && self.catalog.store && typeof self.catalog.store.getSnapshot === "function"
                ? self.catalog.store.getSnapshot()
                : null;
              var snap = self.store && typeof self.store.getSnapshot === "function" ? self.store.getSnapshot() : null;
              if (!catalogState || catalogState.status !== "ready" || catalogState.value === null || !snap) return;
              // A recorded pick wins even over a non-null `current`: the host
              // seeds `current` from the catalog default, so "current is set"
              // does NOT mean "current is what the user asked for".
              var picked = pickedFor(sid);
              if (!picked && snap.status !== "loading" && snap.current !== null) return;
              var chosen = picked || self.__srrCurrentSelection || catalogState.value.default;
              if (!chosen) return;
              try { self.__srrCurrentSelection = chosen; } catch (_eChosen) {}
              var groups = catalogState.value.groups || [];
              var routable = groups.some(function (group) {
                return group.id === chosen.provider && (group.models || []).some(function (model) { return model.id === chosen.model; });
              });
              self.store.set({
                current: chosen,
                routable: routable,
                groups: groups,
                failures: catalogState.value.failures || [],
                status: "ready",
                pending: null,
                error: null
              });
            } catch (_eSync) {}
          };
          proto.__srrProtoSyncWrapped = true;
          disposeFns.push(function () {
            proto.syncInputs = originalProtoSyncInputs;
            try { delete proto.__srrProtoSyncWrapped; } catch (_e) {}
          });
        }
        if (typeof proto.select === "function" && proto.__srrProtoSelectWrapped !== true) {
          var originalProtoSelect = proto.select;
          proto.select = function (selection) {
            var self = this;
            var sid = self && self.sessionId;
            var isChild = typeof self.available === "function" ? !self.available() : shimSaysSubagent(sid);
            if (!isChild) return originalProtoSelect.apply(this, arguments);
            return selectViaRoute({
              childId: sid,
              sessionId: sid,
              provider: selection && selection.provider,
              model: selection && selection.model,
              reasoningEffort: selection && selection.reasoningEffort
            }).then(function (outcome) {
              if (outcome && outcome.ok === false) {
                if (outcome.error && outcome.error.code === "not-live") {
                  return originalProtoSelect.call(self, selection);
                }
                try {
                  if (self.store && typeof self.store.update === "function") {
                    self.store.update(function (s) {
                      s.status = "error";
                      s.pending = null;
                      s.error = (outcome.error && outcome.error.code ? String(outcome.error.code) : "subagent-role-router") + ": " + (outcome.error && outcome.error.message ? String(outcome.error.message) : "reroute failed");
                    });
                  }
                } catch (_e1) {}
                return outcome;
              }
              try {
                self.__srrCurrentSelection = {
                  provider: selection && selection.provider,
                  model: selection && selection.model,
                  reasoningEffort: selection && selection.reasoningEffort
                };
                rememberPicked(sid, self.__srrCurrentSelection);
                if (self.store && typeof self.store.update === "function") {
                  self.store.update(function (s) {
                    s.status = "ready";
                    s.pending = null;
                    s.error = null;
                    if (selection && typeof selection === "object") {
                      s.current = { provider: selection.provider, model: selection.model, reasoningEffort: selection.reasoningEffort };
                    }
                  });
                }
              } catch (_e2) {}
              return { ok: true, value: void 0 };
            });
          };
          proto.__srrProtoSelectWrapped = true;
          disposeFns.push(function () {
            proto.select = originalProtoSelect;
            try { delete proto.__srrProtoSelectWrapped; } catch (_e) {}
          });
        }
      };
      var wrapDirectory = function (dir) {
        if (!dir || typeof dir !== "object") return dir;
        try { liftProto(dir); } catch (_e0) {}
        var sid = dir.sessionId;
        // Seed the fresh instance from the recorded pick BEFORE any paint:
        // the host rebuilds this directory from the catalog default, which is
        // exactly the value the label used to snap back to.
        var seeded = pickedFor(sid);
        if (seeded) {
          try {
            dir.__srrCurrentSelection = seeded;
            if (dir.store && typeof dir.store.update === "function") {
              dir.store.update(function (s) {
                if (!s) return;
                s.current = seeded;
                if (s.status !== "selecting") { s.status = "ready"; s.pending = null; s.error = null; }
              });
            }
          } catch (_eSeed) {}
        }
        try {
          if (shimSaysSubagent(sid)) {
            if (typeof dir.load === "function") dir.load().catch(function () {});
            liveRouteGet(sid).then(function (res) {
              if (!res || res.ok !== true || !res.value) return;
              var ov = res.value.override;
              if (ov) {
                dir.__srrCurrentSelection = ov;
                rememberPicked(sid, ov);
                if (dir.store && typeof dir.store.update === "function") {
                  dir.store.update(function (s) {
                    if (s) s.current = { provider: ov.provider, model: ov.model, reasoningEffort: ov.reasoningEffort };
                  });
                }
                return;
              }
              // Reset: forget the stale pick and show what the child will
              // actually use next, so the label stops advertising a model the
              // route no longer selects.
              forgetPicked(sid);
              var live = res.value.actual;
              if (!live) return;
              dir.__srrCurrentSelection = live;
              if (dir.store && typeof dir.store.update === "function") {
                dir.store.update(function (s) {
                  if (s) s.current = { provider: live.provider, model: live.model, reasoningEffort: live.reasoningEffort };
                });
              }
            });
          }
        } catch (_eInit) {}
        if (typeof dir.select !== "function" || dir.__srrSelectRouted === true) return dir;
        var store = dir.store;
        var originalSelect = dir.select;
        dir.select = function (selection) {
          if (!shimSaysSubagent(sid)) return originalSelect.apply(this, arguments);
          return selectViaRoute({
            childId: sid,
            sessionId: sid,
            provider: selection && selection.provider,
            model: selection && selection.model,
            reasoningEffort: selection && selection.reasoningEffort
          }).then(function (outcome) {
            if (outcome && outcome.ok === false) {
              try {
                if (store && typeof store.update === "function") {
                  store.update(function (s) {
                    s.status = "error";
                    s.pending = null;
                    s.error = (outcome.error && outcome.error.code ? String(outcome.error.code) : "subagent-role-router") + ": " + (outcome.error && outcome.error.message ? String(outcome.error.message) : "reroute failed");
                  });
                }
              } catch (_e1) {}
              return outcome;
            }
            try {
              dir.__srrCurrentSelection = {
                provider: selection && selection.provider,
                model: selection && selection.model,
                reasoningEffort: selection && selection.reasoningEffort
              };
              rememberPicked(sid, dir.__srrCurrentSelection);
              if (store && typeof store.update === "function") {
                store.update(function (s) {
                  s.status = "ready";
                  s.pending = null;
                  s.error = null;
                  if (selection && typeof selection === "object") {
                    s.current = { provider: selection.provider, model: selection.model, reasoningEffort: selection.reasoningEffort };
                  }
                });
              }
            } catch (_e2) {}
            return { ok: true, value: void 0 };
          });
        };
        try { dir.__srrSelectRouted = true; } catch (_e3) {}
        disposeFns.push(function () {
          try { delete dir.select; } catch (_e) { dir.select = originalSelect; }
          try { delete dir.__srrSelectRouted; } catch (_e4) {}
        });
        return dir;
      };
      var resolverOf = typeof deps.resolver === "function"
        ? deps.resolver
        : (deps.resolver
          ? function () { return deps.resolver; }
          : function () { return typeof ctx.get === "function" ? ctx.get("modelDirectories") : undefined; });
      var wrapResolver = function (resolver) {
        if (!resolver || typeof resolver.directoryFor !== "function" || resolver.__srrDirectoryForWrapped === true) return false;
        var originalDirFor = resolver.directoryFor;
        resolver.directoryFor = function () {
          var dir = originalDirFor.apply(this, arguments);
          try { return wrapDirectory(dir); } catch (_e5) { return dir; }
        };
        resolver.__srrDirectoryForWrapped = true;
        try {
          if (resolver.live && resolver.live.directories) {
            var it = resolver.live.directories.values;
            if (it && typeof it[Symbol.iterator] === "function") {
              for (var d of it) { wrapDirectory(d); }
            }
          }
        } catch (_eLive) {}
        try {
          var activeId = resolveCurrentSessionId();
          if (activeId) {
            var d0 = originalDirFor.call(resolver, activeId);
            if (d0) wrapDirectory(d0);
          }
        } catch (_eProbe) {}
        disposeFns.push(function () {
          resolver.directoryFor = originalDirFor;
          try { delete resolver.__srrDirectoryForWrapped; } catch (_e6) {}
        });
        LIVE_SHIM.installed = true;
        return true;
      };

      // The resolver service can mount after this plugin's apply, so probe a
      // bounded number of times instead of giving up after one look.
      var attempts = deps.attempts === undefined ? 20 : deps.attempts;
      var delay = deps.delay === undefined ? 250 : deps.delay;
      var attempt = 0;
      var whenReady = new Promise(function (resolve) { resolveReady = resolve; });
      var resolveReady;
      var tryWrap = function () {
        if (disposed) { resolveReady(false); return; }
        var resolver = null;
        try { resolver = resolverOf(); } catch (_e) { resolver = null; }
        if (wrapResolver(resolver)) {
          resolveReady(true);
          return;
        }
        attempt += 1;
        if (attempt >= attempts) { resolveReady(false); return; }
        sleepFn(delay).then(tryWrap);
      };
      tryWrap();

      return {
        whenReady: whenReady,
        dispose: function () {
          if (disposed) return;
          disposed = true;
          LIVE_SHIM.installed = false;
          for (var i = disposeFns.length - 1; i >= 0; i--) {
            try { disposeFns[i](); } catch (_e) {}
          }
        }
      };
    }

    /** Stable no-op hook stand-in so the hook COUNT never changes between renders. */
    var NO_SESSIONS_HOOK = function (selector) {
      return selector({ byId: {} });
    };

    // No polling timer anywhere: the picker verifies the live route on
    // demand (session-store change, focus, visibility, SSE announcement).
    // The only timer left is the SSE client's own retry backoff.
    var LIVE_SSE_PATH = LIVE_ROUTE_PATH + "/events";
    var LIVE_SSE_FAILURES_TO_DEGRADE = 3;
    var LIVE_SSE_RETRY_MS = 30000;
    var LIVE_SSE_RETRY_LIMIT = 3;
    // epoch per session from the last answer the picker saw. A change means
    // the host reloaded and every cached revision is meaningless.
    var LIVE_EPOCH_BY_SESSION = {};

    /**
     * Effort choices for one model. Only what the model actually declares is
     * offered: inventing low/medium/high for a model that declares nothing
     * makes the host reject the next request with UNSUPPORTED_REASONING_EFFORT.
     */
    function effortChoicesFor(model) {
      return model && model.reasoning && Array.isArray(model.reasoning.efforts)
        ? model.reasoning.efforts
        : [];
    }

    function resolveCurrentSessionId(explicitId) {
      if (typeof explicitId === "string" && explicitId !== "") return explicitId;
      try {
        var uiSession = serviceOf("uiSession");
        var key = uiSession && uiSession.current && uiSession.current.value ? uiSession.current.value.key : undefined;
        if (typeof key === "string" && key !== "") return key;
        var sessions = serviceOf("sessions");
        var cur = sessions && sessions.list && typeof sessions.list.getSnapshot === "function" ? sessions.list.getSnapshot().current : undefined;
        if (typeof cur === "string" && cur !== "") return cur;
      } catch (_e) {}
      return explicitId;
    }

    function LiveRoutePicker(props) {
      var sid = typeof props === "string" ? props : (props && props.sessionId);
      var sessionId = resolveCurrentSessionId(sid);
      // First line that can only run if this component was actually MOUNTED by
      // a slot outlet. Its absence in `live-route-debug.log` while the page is
      // up is proof the slot never rendered this entry — which no later log can
      // distinguish from "mounted but decided null".
      if (typeof window !== "undefined") {
        window.__srrPickerRenders = window.__srrPickerRenders || {};
        var renderKey = sessionId || "?";
        if (!window.__srrPickerRenders[renderKey]) {
          window.__srrPickerRenders[renderKey] = true;
          srrLog("PICKER_RENDER", { sid: sessionId, propsSid: typeof sid === "string" ? sid : undefined });
        }
      }
      var t = props.t || function (key) { return key; };
      var catalog = props.catalog;
      var useSessions = typeof props.useSessions === "function" ? props.useSessions : NO_SESSIONS_HOOK;
      // The host session store, handed over by the injector the same way the
      // batch card gets it. The picker VERIFIES on its changes instead of
      // polling; absent, verification falls back to mount+focus only.
      var sessionsList = props.sessionsList || null;

      // Only subagent conversations carry this control. Two independent reads
      // are consulted, because they fail in different situations: the sessions
      // store hook is what the header view populates, while the sidebar's
      // embedded pane can render before that store carries the child, and a
      // false negative here means the user gets NO model control at all (the
      // host deliberately hides its own for subagents). The service probe asks
      // the host the same question the host asks itself.
      // The selector is cached per session id: a fresh closure on every render
      // makes `useSyncExternalStore` see a new snapshot identity each time, and
      // a hook that throws would abort this component's commit with no other
      // trace at all (no mount, no log) — the exact silent failure this
      // diagnostic bracket exists to find.
      // The selector's identity is memoised so `useSyncExternalStore` sees the
      // same closure between renders. It is built HERE, inline, on purpose: a
      // module-level helper of this exact shape once resolved to nothing at
      // runtime, and the resulting throw inside the hook aborted the entry's
      // commit without leaving a single line of evidence.
      var selectorForSessions = React.useMemo(function () {
        var k = typeof sessionId === "string" ? sessionId : "";
        var bare = k.indexOf("session-") === 0 ? k.slice(8) : k;
        return function (state) {
          if (!k) return false;
          var summary = (state && state.byId && state.byId[k])
                     || (state && state.byId && state.byId[bare])
                     || (state && state.byId && state.byId["session-" + bare]);
          return Boolean(summary && (summary.origin === "subagent" || summary.parentId || summary.parentSession || summary.parentSessionId));
        };
      }, [sessionId]);
      var storeSaysSubagent = false;
      try {
        storeSaysSubagent = useSessions(selectorForSessions);
      } catch (hookError) {
        srrLog("PICKER_HOOK_ERR", {
          sid: sessionId,
          message: String(hookError && hookError.message ? hookError.message : hookError)
        });
        storeSaysSubagent = false;
      }
      var isSubagent = storeSaysSubagent || isSubagentSession(sessionId);
      // Second bracket: the component reached its verdict. Between this line
      // and the mount effect there are only hook registrations, so a RENDER
      // line without a DECIDED/MOUNT line means the commit itself never
      // happened (an ancestor boundary or a throw further down the body).
      if (typeof window !== "undefined") {
        window.__srrPickerDecided = window.__srrPickerDecided || {};
        var decidedKey = (sessionId || "?") + ":" + String(isSubagent);
        if (!window.__srrPickerDecided[decidedKey]) {
          window.__srrPickerDecided[decidedKey] = true;
          srrLog("PICKER_DECIDED", { sid: sessionId, storeSays: storeSaysSubagent, isSubagent: isSubagent });
        }
      }

      // Mount-time diagnosis, once per session id: did this picker decide the
      // conversation is a child at all? A page with no control is most often
      // this boolean being false, and nothing else in the plugin can tell.
      React.useEffect(function () {
        srrLog("PICKER_MOUNT", {
          sid: sessionId,
          propsSessionId: typeof sid === "string" ? sid : undefined,
          storeSaysSubagent: storeSaysSubagent,
          serviceSaysSubagent: isSubagentSession(sessionId),
          isSubagent: isSubagent
        });
      }, [sessionId, isSubagent]);

      var routeState = React.useState(null);
      var route = routeState[0];
      var setRoute = routeState[1];
      var groupsState = React.useState([]);
      var groups = groupsState[0];
      var setGroups = groupsState[1];
      var pickState = React.useState(null);
      var pick = pickState[0];
      var setPick = pickState[1];
      var busyState = React.useState(false);
      var busy = busyState[0];
      var setBusy = busyState[1];
      var errorState = React.useState("");
      var error = errorState[0];
      var setError = errorState[1];
      var noteState = React.useState("");
      var note = noteState[0];
      var setNote = noteState[1];
      var openState = React.useState(false);
      var open = openState[0];
      var setOpen = openState[1];
      var rootRef = React.useRef(null);
      var menuRef = React.useRef(null);
      // Up by default (composer surface); the header surface passes "down" so
      // the menu opens away from the window's top edge.
      var placement = props.placement === "down" ? "down" : "up";
      React.useEffect(function () {
        if (!open) return;
        var onDown = function (event) {
          // The portal panel lives under document.body, outside the trigger
          // root — clicking inside it must not count as "outside".
          var root = rootRef.current;
          var menu = menuRef.current;
          if (!(event.target instanceof Node)) return;
          if (root && root.contains(event.target)) return;
          if (menu && menu.contains(event.target)) return;
          setOpen(false);
        };
        document.addEventListener("mousedown", onDown);
        return function () { document.removeEventListener("mousedown", onDown); };
      }, [open]);

      // After the panel is committed, report what actually landed in the DOM.
      // "The menu does not appear" has several very different causes (never
      // opened, rendered off-screen, zero height, covered), and only this can
      // tell them apart from the user's own machine.
      React.useEffect(function () {
        if (!open) return;
        if (typeof setTimeout !== "function") return;
        var timer = setTimeout(function () {
          var info = {
            sid: sessionId,
            canPortal: canPortal,
            hasReactDOM: Boolean(ReactDOM),
            panels: [],
            shift: 0
          };
          try {
            var nodes = document.querySelectorAll(".dsm-live-route-panel");
            for (var i = 0; i < nodes.length; i++) {
              var r = nodes[i].getBoundingClientRect();
              var cs = window.getComputedStyle(nodes[i]);
              info.panels.push({
                rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
                position: cs.position,
                zIndex: cs.zIndex,
                display: cs.display,
                visibility: cs.visibility,
                opacity: cs.opacity,
                overflow: cs.overflow,
                kids: nodes[i].children.length,
                parent: nodes[i].parentElement ? String(nodes[i].parentElement.className).slice(0, 60) : null
              });
            }
            var root = rootRef.current;
            if (root && typeof root.getBoundingClientRect === "function") {
              var rr = root.getBoundingClientRect();
              info.shift = Math.round(rr.left);
              info.trigger = [Math.round(rr.left), Math.round(rr.top), Math.round(rr.width), Math.round(rr.height)];
            }
          } catch (probeError) {
            info.error = String(probeError && probeError.message ? probeError.message : probeError);
          }
          srrLog("PICKER_OPEN", info);
        }, 140);
        return function () { if (typeof clearTimeout === "function") clearTimeout(timer); };
      }, [open]);

      // The SSE effect and the verification effect live in different closures;
      // this ref is the seam — the verifier publishes itself here on mount.
      var verifyRef = React.useRef(function () {});

      // Verify the live route on DEMAND — there is no polling timer. Signals,
      // cheapest first: mount, the host session store changing for this child
      // (running/exit/spawn), window focus or a return to visible, and the
      // plugin's own SSE stream for writes made in OTHER windows or by model
      // tools (which the store never sees). Defenses kept from the poll era:
      // in-flight coalescing, a monotonic probe sequence against late
      // responses, and a signature check so an unchanged answer is a no-op.
      React.useEffect(function () {
        if (!isSubagent) {
          setRoute(null);
          return;
        }
        var alive = true;
        var probeSeq = 0;
        var inFlight = false;
        var lastAnswer = null;
        var verifiedOnce = false;
        var lastStoreSignature = null;

        var apply = function (body) {
          var ok = Boolean(body && body.ok === true && body.value);
          var value = ok ? body.value : null;
          // Only touch state when the answer moved. Re-setting the same
          // route re-rendered the whole picker (and logged) for nothing.
          var sig = routePollSignature(value, ok, body);
          if (sig === lastAnswer) return;
          lastAnswer = sig;
          setRoute(value);
        };

        var verify = function () {
          if (!alive || inFlight) return;
          var mySeq = ++probeSeq;
          inFlight = true;
          liveRouteGet(sessionId).then(function (body) {
            inFlight = false;
            if (!alive || mySeq !== probeSeq) return;
            // A new epoch means the host reloaded the plugin: every revision
            // cached anywhere is stale, so accept the full answer fresh.
            if (noteRouteEpoch(sessionId, body ? body.epoch : undefined)) {
              srrLog("LIVE_EPOCH_CHANGED", { sid: sessionId, epoch: body ? body.epoch : undefined });
              lastAnswer = null;
            }
            apply(body);
          });
        };

        var maybeVerify = function (force) {
          if (!alive) return;
          if (!force) {
            var snapshot = sessionsList ? sessionsList.getSnapshot() : null;
            var signature = snapshot !== null ? liveStoreSignature(snapshot, sessionId) : null;
            // Without a store there is no signal to compare — only the mount
            // check (and focus, forced) runs, same policy as the batch card.
            if (verifiedOnce && signature === lastStoreSignature) return;
          }
          verifiedOnce = true;
          lastStoreSignature = sessionsList ? liveStoreSignature(sessionsList.getSnapshot(), sessionId) : null;
          verify();
        };
        verifyRef.current = maybeVerify;

        maybeVerify(false);
        var unsubscribe = null;
        if (sessionsList && typeof sessionsList.subscribe === "function") {
          unsubscribe = sessionsList.subscribe(function () { maybeVerify(false); });
        }
        var onFocus = function () { maybeVerify(true); };
        var onVisibility = function () {
          if (typeof document === "undefined" || !document.hidden) maybeVerify(true);
        };
        if (typeof window !== "undefined" && window && typeof window.addEventListener === "function") {
          window.addEventListener("focus", onFocus);
          if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
            document.addEventListener("visibilitychange", onVisibility);
          }
        }
        return function () {
          alive = false;
          verifyRef.current = function () {};
          if (typeof unsubscribe === "function") unsubscribe();
          if (typeof window !== "undefined" && window && typeof window.removeEventListener === "function") {
            window.removeEventListener("focus", onFocus);
            if (typeof document !== "undefined" && typeof document.removeEventListener === "function") {
              document.removeEventListener("visibilitychange", onVisibility);
            }
          }
        };
      }, [isSubagent, sessionId]);

      // Cross-window announcements (Stage B): the plugin's SSE stream tells
      // this page that a route write or an applied switch happened. Every
      // event triggers a verify — the payload is never trusted, the GET is.
      // A stream that never opens costs nothing: the signals above still
      // converge this window on the next focus or store change.
      React.useEffect(function () {
        if (!isSubagent) return undefined;
        var release = liveRouteEventsSubscribe(function (event) {
          if (!event) return;
          if (event.type === "resync") { verifyRef.current(true); return; }
          if (event.type !== "route") return;
          if (canonicalSseChildId(event.childId) !== canonicalSseChildId(sessionId)) return;
          verifyRef.current(true);
        });
        return release;
      }, [isSubagent, sessionId]);

      // Catalog is shared with the settings card (same `remote.session.modelCatalog`).
      React.useEffect(function () {
        if (!isSubagent || typeof catalog !== "function") return;
        var alive = true;
        catalog().then(function (next) {
          if (alive) setGroups(Array.isArray(next) ? next : []);
        });
        return function () { alive = false; };
      }, [isSubagent]);

      // Re-seed the selection whenever the effective route changes. Keyed on a
      // string so an identical poll answer does not clobber a pick in progress.
      var routeSignature = route === null
        ? ""
        : [
            route.provider,
            route.model,
            route.reasoningEffort || "",
            route.override ? route.override.provider + "/" + route.override.model + "/" + (route.override.reasoningEffort || "") : "",
            String(route.revision === void 0 || route.revision === null ? 0 : route.revision)
          ].join("|");
      React.useEffect(function () {
        if (route === null) {
          setPick(null);
          return;
        }
        var effective = route.override !== null && route.override !== undefined
          ? route.override
          : { provider: route.provider, model: route.model, reasoningEffort: route.reasoningEffort };
        setPick({
          provider: effective.provider || "",
          model: effective.model || "",
          effort: effective.reasoningEffort || ""
        });
        // Follow the server: an override is the pick, no override means the
        // cache must be dropped so a rebuild seeds the real route instead.
        if (route.override !== null && route.override !== void 0) {
          rememberPicked(sessionId, route.override);
        } else {
          forgetPicked(sessionId);
        }
      }, [routeSignature]);

      // Exactly one model control on a subagent page. This attribute is what
      // the CSS above keys on to suppress the theme's seat (and any host seat
      // a future build starts rendering). It is set only while this picker is
      // actually mounted for a child session, so parent conversations keep
      // their untouched native control.
      // A child page is exactly where a forgotten interrupt shows up, so make
      // sure the stop measurement is installed while this control is mounted.
      React.useEffect(function () {
        installStopFallback({ sessionId: sessionId });
      }, [sessionId]);

      React.useEffect(function () {
        // Claimed only while this picker can actually render. If the child is
        // not live yet (no route), the claim is released and the theme's own
        // seat — which the selection shim makes functional — stays visible, so
        // the user is never left without a control.
        if (!isSubagent || route === null || pick === null) return undefined;
        return claimModelControl(true, rootRef.current);
      }, [isSubagent, route === null, pick === null]);

      if (!isSubagent) {
        if (typeof window !== "undefined") {
          window.__srrPickerNull = window.__srrPickerNull || {};
          var nullKey = "not-child:" + (sessionId || "?");
          if (!window.__srrPickerNull[nullKey]) {
            window.__srrPickerNull[nullKey] = true;
            srrLog("PICKER_NULL", { reason: "not-child", sid: sessionId });
          }
        }
        return null;
      }
      // The picker is the single model control on a subagent page: the host
      // does not render its own seat for child sessions, and the theme's seat
      // cannot work there (its select is gated). Rather than hiding this
      // control whenever a theme appears — which left the user with a control
      // that silently does nothing — this control stays and the others are
      // suppressed by the body attribute above.
      if (route === null || pick === null) {
        if (typeof window !== "undefined") {
          window.__srrPickerNull = window.__srrPickerNull || {};
          var waitKey = "no-route:" + (sessionId || "?") + ":" + String(route === null) + String(pick === null);
          if (!window.__srrPickerNull[waitKey]) {
            window.__srrPickerNull[waitKey] = true;
            srrLog("PICKER_NULL", { reason: "no-route", sid: sessionId, routeNull: route === null, pickNull: pick === null });
          }
        }
        return null;
      }

      var submit = function (next) {
        if (busy) return;
        setBusy(true);
        setError("");
        setNote("");
        liveRoutePost("select", {
          childId: sessionId,
          provider: next.provider,
          model: next.model,
          reasoningEffort: next.effort ? next.effort : undefined
        }).then(function (body) {
          setBusy(false);
          if (body && body.ok === true && body.value) {
            // A pick made here must survive the host rebuilding this
            // session's directory (it has no projection of its own to read).
            rememberPicked(sessionId, { provider: next.provider, model: next.model, reasoningEffort: next.effort || undefined });
            if (noteRouteEpoch(sessionId, body.epoch)) {
              srrLog("LIVE_EPOCH_CHANGED", { sid: sessionId, epoch: body.epoch });
            }
            setRoute(body.value);
            setNote(t("live.pending"));
            return;
          }
          var message = body && body.error && body.error.message ? body.error.message : t("live.notLive");
          setError(t("live.failed", { message: message }));
        });
      };

      var reset = function () {
        if (busy) return;
        setBusy(true);
        setError("");
        setNote("");
        forgetPicked(sessionId);
        liveRoutePost("clear", { childId: sessionId }).then(function (body) {
          setBusy(false);
          if (body && body.ok === true && body.value) {
            if (noteRouteEpoch(sessionId, body.epoch)) {
              srrLog("LIVE_EPOCH_CHANGED", { sid: sessionId, epoch: body.epoch });
            }
            setRoute(body.value);
            return;
          }
          var message = body && body.error && body.error.message ? body.error.message : t("live.notLive");
          setError(t("live.failed", { message: message }));
        });
      };

      // Model choices: every catalog model under its provider, plus the current
      // route as a synthetic option when the catalog has not caught up yet.
      var knownProviders = groups.map(function (group) { return group.id; });
      var synthetic = null;
      if (pick.provider !== "" && pick.model !== "" && knownProviders.indexOf(pick.provider) < 0) {
        synthetic = { id: pick.provider, name: pick.provider, models: [{ id: pick.model, name: pick.model }] };
      }
      var providerGroups = synthetic === null ? groups : groups.concat([synthetic]);

      var selectedGroup = null;
      for (var gi = 0; gi < providerGroups.length; gi++) {
        if (providerGroups[gi].id === pick.provider) { selectedGroup = providerGroups[gi]; break; }
      }
      var selectedModel = null;
      if (selectedGroup !== null) {
        var models = selectedGroup.models || [];
        for (var mi = 0; mi < models.length; mi++) {
          if (models[mi].id === pick.model) { selectedModel = models[mi]; break; }
        }
      }
      var effortChoices = effortChoicesFor(selectedModel);
      if (pick.effort !== "" && !effortChoices.some(function (candidate) { return candidate.id === pick.effort; })) {
        effortChoices = effortChoices.concat([{ id: pick.effort, name: pick.effort }]);
      }

      // Theme-aligned trigger under this plugin's OWN class names
      // (dsm-live-route-seat/btn/tag). Never borrow the claude-style theme's
      // dsh-claude-model-* names: its popover manager sweeps the document for
      // those selectors and deletes every element it does not own, which
      // removed this trigger mid-session. Own names + fallback CSS below keep
      // the visuals while staying invisible to the theme's DOM sweeps.
      var providerName = selectedGroup ? (selectedGroup.name || selectedGroup.id) : pick.provider;
      var modelName = selectedModel ? (selectedModel.name || selectedModel.id) : (pick.model || t("live.pickOne"));
      var display = pick.model !== "" && providerName !== "" ? modelName + " · " + providerName : modelName;
      var effortEntry = null;
      for (var ei = 0; ei < effortChoices.length; ei++) {
        if (effortChoices[ei].id === pick.effort) { effortEntry = effortChoices[ei]; break; }
      }
      var effortName = effortEntry ? (effortEntry.name || effortEntry.id) : "";
      // An empty effort means "engine default" — the old select showed that as
      // an explicit label, and hiding it read as "the feature is gone".
      if (effortName === "" && pick.model !== "") effortName = t("row.effortDefault");

      var trigger = React.createElement("button", {
        className: "dsm-live-route-seat dsm-live-route-trigger" + (busy ? " dsm-live-route-busy" : ""),
        type: "button",
        disabled: busy,
        "aria-expanded": open ? "true" : "false",
        "aria-haspopup": "menu",
        title: error !== "" ? error : t("live.title"),
        onClick: function () {
          srrLog("PICKER_TOGGLE", { sid: sessionId, to: !open });
          setOpen(!open);
        }
      },
        React.createElement("span", { className: "dsm-live-route-btn" },
          React.createElement("span", { className: "dsm-live-route-btn-label" }, display),
          effortName !== "" ? React.createElement("span", { className: "dsm-live-route-tag" }, effortName) : null,
          React.createElement("span", { className: "dsm-live-route-caret", "aria-hidden": true },
            // Official icon when available (theme-aware stroke), drawn glyph as
            // the fallback for host builds that renamed the icon family.
            IconChevronDown ? React.createElement(IconChevronDown) : "\u25be"
          )
        )
      );

      // Status lives INSIDE the panel, never inline in the header row: the
      // claude-style theme pulls the header into the title bar and lays it
      // out with its own measurements, so extra inline text there collides.
      var status = error !== ""
        ? React.createElement("div", { className: "dsm-live-route-error", role: "status" }, error)
        : note !== ""
          ? React.createElement("div", { className: "dsm-live-route-note", role: "status" }, note)
          : groups.length === 0
            ? React.createElement("div", { className: "dsm-live-route-note" }, t("live.noCatalog"))
            : null;

      var panel = null;
      if (open) {
        // Panel rows use this plugin's own classes; the unscoped fallback CSS
        // mirrors the host picker's metrics so the menu reads native in every
        // theme without borrowing theme-managed selector names.
        var sections = providerGroups.map(function (group) {
          var models = Array.isArray(group.models) ? group.models : [];
          if (models.length === 0) return null;
          return React.createElement("div", { key: group.id, className: "dsm-live-route-group-section" },
            React.createElement("div", { className: "dsm-live-route-group-name" }, group.name || group.id),
            models.map(function (model) {
              var on = group.id === pick.provider && model.id === pick.model;
              return React.createElement("button", {
                key: group.id + "|" + model.id,
                type: "button",
                className: "dsm-live-route-option" + (on ? " dsm-live-route-item-on" : ""),
                disabled: busy,
                onClick: function () {
                  var next = { provider: group.id, model: model.id, effort: "" };
                  // The menu stays open on purpose: the effort chips live at
                  // the bottom of the SAME panel, and closing here sent the
                  // user back to the composer before they could ever reach
                  // them ("选不到推理强度").
                  setPick(next);
                  submit(next);
                }
              },
                React.createElement("span", { className: "dsm-live-route-check" }, on ? "✓" : ""),
                React.createElement("span", { className: "dsm-live-route-name" }, model.name || model.id)
              );
            })
          );
        });
        // Effort chips: always offered once a model is picked. Models that
        // declare no levels get just the "default" chip; unsupported custom
        // levels are still never invented here (effortChoicesFor returns []).
        var effortRow = pick.model === "" ? null : React.createElement("div", { className: "dsm-live-route-efforts" },
          React.createElement("span", { className: "dsm-live-route-efforts-label" }, t("row.effort")),
          React.createElement("button", {
            type: "button",
            className: "dsm-live-route-chip" + (pick.effort === "" ? " dsm-live-route-chip-on" : ""),
            disabled: busy,
            onClick: function () {
              var next = { provider: pick.provider, model: pick.model, effort: "" };
              setPick(next);
              submit(next);
            }
          }, t("row.effortDefault")),
          effortChoices.map(function (candidate) {
            var on = candidate.id === pick.effort;
            return React.createElement("button", {
              key: candidate.id,
              type: "button",
              className: "dsm-live-route-chip" + (on ? " dsm-live-route-chip-on" : ""),
              disabled: busy,
              onClick: function () {
                var next = { provider: pick.provider, model: pick.model, effort: candidate.id };
                setPick(next);
                submit(next);
              }
            }, candidate.name || candidate.id);
          })
        );
        // Fixed viewport coordinates are computed from the trigger rect on
        // every open — for the portal path AND the fallback path, because an
        // ancestor in the slot row (composer bar) clips or re-anchors
        // absolutely-positioned children.
        var menuStyle = null;
        var root = rootRef.current;
        if (root && typeof root.getBoundingClientRect === "function" && typeof window !== "undefined") {
          var rect = root.getBoundingClientRect();
          var vw = window.innerWidth;
          var vh = window.innerHeight;
          var width = Math.min(280, Math.max(200, vw * 0.86));
          var left = Math.min(Math.max(8, rect.right - width), Math.max(8, vw - width - 8));
          menuStyle = placement === "down"
            ? { left: Math.round(left), top: Math.round(rect.bottom + 6), width: Math.round(width), maxHeight: Math.round(Math.max(160, Math.min(360, vh - rect.bottom - 16))) }
            : { left: Math.round(left), bottom: Math.round(vh - rect.top + 6), width: Math.round(width), maxHeight: Math.round(Math.max(160, Math.min(360, rect.top - 16))) };
        }
        // The model list scrolls; the effort row is PINNED to the panel's
        // bottom edge so it is reachable no matter how long the list is. When
        // the effort row was just the last row of the scroll area it sat below
        // the fold and read as "cannot pick an effort at all".
        var listContent = [status];
        for (var mi = 0; mi < sections.length; mi++) {
          if (sections[mi] !== null) listContent.push(sections[mi]);
        }
        var panelBody = [React.createElement("div", { key: "dsm-list", className: "dsm-live-route-list" }, listContent)];
        if (effortRow !== null) {
          panelBody.push(React.createElement("div", { key: "dsm-foot", className: "dsm-live-route-footer" },
            React.createElement("div", { key: "dsm-live-route-divider", className: "dsm-live-route-divider", role: "separator" }),
            effortRow
          ));
        }
        if (canPortal && menuStyle !== null) {
          // Own element inside a portal, NOT the host MenuSurface primitive:
          // the primitive controls its own placement/measurement and ignored
          // the coordinates handed to it, so the panel came up somewhere the
          // user never saw while the slot row reflowed around it.
          panel = ReactDOM.createPortal(
            React.createElement("div", {
              ref: menuRef,
              className: "dsm-live-route-panel dsm-live-route-panel-fixed",
              style: Object.assign({}, menuStyle, { position: "fixed", zIndex: 1200 }),
              role: "menu"
            }, panelBody),
            document.body
          );
        } else {
          // No portal available: same fixed-position panel, still never
          // anchored to the clipping slot row. When the trigger could not be
          // measured either, fall back to a corner instead of an unpositioned
          // block — an in-flow panel reflows the composer row, which reads to
          // the user as "the row jumps sideways and no menu opens".
          panel = React.createElement("div", {
            ref: menuRef,
            className: "dsm-live-route-panel dsm-live-route-panel-fixed",
            style: menuStyle !== null
              ? Object.assign({}, menuStyle, { position: "fixed", zIndex: 1200 })
              : { position: "fixed", right: 12, bottom: 12, width: 280, maxHeight: 320, zIndex: 1200 },
            role: "menu"
          }, panelBody);
        }
      }

      var resetButton = route.override === null || route.override === undefined
        ? null
        : React.createElement("button", {
            className: "dsm-live-route-reset",
            type: "button",
            disabled: busy,
            title: t("live.resetTitle"),
            "aria-label": t("live.resetTitle"),
            onClick: reset
          }, "\u21ba");

      return React.createElement(React.Fragment, null,
        React.createElement("span", { className: "dsm-live-route", "data-live-route": sessionId, ref: rootRef },
          trigger,
          resetButton
        ),
        panel
      );
    }

    /** Register the picker in both surfaces; returns an unregister function. */
    function registerLiveRoutePicker(ctx, catalog) {
      // Same face the batch card uses: {getSnapshot, subscribe} or null when
      // the host store is not reachable. The picker verifies on its changes
      // instead of polling.
      var sessionsService = null;
      try { sessionsService = ctx.get("sessions"); } catch (_e) {}
      var sessionsList = sessionsService && sessionsService.list;
      var sessionsFace = sessionsList && typeof sessionsList.getSnapshot === "function" && typeof sessionsList.subscribe === "function"
        ? { getSnapshot: function () { return sessionsList.getSnapshot(); }, subscribe: function (cb) { return sessionsList.subscribe(cb); } }
        : null;
      try {
        // Surface 1: the resident session header (main panel, full-page view).
        var regOff1 = null;
        var injectOff1 = ctx.slots.inject("conversation.session.header.actions", function () {
          srrLog("PICKER_REGISTERING", { slot: "conversation.session.header.actions" });
          regOff1 = ctx.slots.register({
            name: "conversation.session.header.actions",
            id: "subagent-role-router-live-route",
            order: 20,
            locale: SUBAGENT_ROW_LOCALE,
            inject: function (sessionIdOrProps) {
              var sid = typeof sessionIdOrProps === "string"
                ? sessionIdOrProps
                : (sessionIdOrProps && sessionIdOrProps.sessionId ? sessionIdOrProps.sessionId : undefined);
              return {
                catalog: catalog,
                placement: "down",
                sessionId: resolveCurrentSessionId(sid),
                sessionsList: sessionsFace
              };
            }
          }, LiveRoutePicker);
          srrLog("PICKER_REGISTERED", { slot: "conversation.session.header.actions", off: typeof regOff1 });
          return regOff1;
        });
        // Surface 2: the composer tool row (`conversation.input.right`, a list
        // slot rendered right before the host model seat). This is the only
        // plugin-reachable surface inside the sidebar's embedded subagent pane:
        // that pane renders the chat body and composer seat only — no session
        // header — so surface 1 never appears there.
        var regOff2 = null;
        var injectOff2 = ctx.slots.inject("conversation.input.right", function () {
          srrLog("PICKER_REGISTERING", { slot: "conversation.input.right" });
          regOff2 = ctx.slots.register({
            name: "conversation.input.right",
            id: "subagent-role-router-live-route",
            order: 20,
            locale: SUBAGENT_ROW_LOCALE,
            inject: function (sessionIdOrProps) {
              var sid = typeof sessionIdOrProps === "string"
                ? sessionIdOrProps
                : (sessionIdOrProps && sessionIdOrProps.sessionId ? sessionIdOrProps.sessionId : undefined);
              return {
                catalog: catalog,
                placement: "up",
                sessionId: resolveCurrentSessionId(sid),
                sessionsList: sessionsFace
              };
            }
          }, LiveRoutePicker);
          srrLog("PICKER_REGISTERED", { slot: "conversation.input.right", off: typeof regOff2 });
          return regOff2;
        });
        return function () {
          if (typeof regOff1 === "function") { try { regOff1(); } catch (_e) {} }
          if (typeof regOff2 === "function") { try { regOff2(); } catch (_e) {} }
          if (typeof injectOff1 === "function") { try { injectOff1(); } catch (_e) {} }
          if (typeof injectOff2 === "function") { try { injectOff2(); } catch (_e) {} }
        };
      } catch (error) {
        console.error("[dsh-subagent-role-router] live route picker failed to register (slots absent):", error);
        srrLog("PICKER_REGISTER_FAILED", { message: String(error && error.message ? error.message : error) });
        return function () { };
      }
    }

    // ── batch switch：把当前对话的直接子代理一次切到同一个模型 ───────────
    //
    // 契约（与 lib/index.js 的 /subagent-role-router/batch* 端点对齐）：
    //   · GET  /batch?parentSessionId=  → {children, models}
    //   · POST /batch/select            → 逐项 {ok, route, override, pending}
    // 卡片只做一件事：选模型 + 选强度 → 应用到本对话所有可写子代理。名单、逐项
    // 勾选、清除覆盖都刻意不做：归属与可写性由后端逐个复验，前端只把
    // selectable 的 childId 全量交出去。强度只认目录报告的 reasoning.efforts；
    // 目录答不上来时只列出本页配置过的值，且不替用户猜具体档位。

    var BATCH_PATH = LIVE_ROUTE_PATH + "/batch";
    // 入口是「按需」的：没有可写子代理时它不该占用输入框。宿主不会向
    // 输入框槽位推送「刚生了一个子代理」这种事件，所以隐藏状态下用一次
    // 廉价的本机查询保持感知（窗口获得焦点时立刻重查）。空对话（没有可写
    // 子代理）退到 15s：入口本来就是隐藏的，没必要每 5s 问一遍。

    var BATCH_FALLBACK = {
      "batch.entry": "批量",
      "batch.entryTitle": "把当前对话的子代理切到同一个模型",
      "batch.title": "子代理快捷切换",
      "batch.close": "关闭",
      "batch.model": "模型",
      "batch.modelPick": "选择模型…",
      "batch.effort": "强度",
      "batch.effortDefault": "模型默认",
      "batch.effortNone": "该模型没有可选推理强度",
      "batch.effortUnverified": "目录未报告强度：只列出本页配置过的值",
      "batch.apply": "应用到当前对话",
      "batch.applying": "应用中…",
      "batch.pickModel": "先选一个模型。",
      "batch.noSession": "没有活动会话。",
      "batch.targets": "将作用于本对话 {n} 个活跃子代理",
      "batch.noTargets": "当前对话暂无活跃子代理",
      "batch.loading": "加载中…",
      "batch.unavailable": "宿主没有提供子代理目录，无法确认归属，已拒绝猜测。",
      "batch.loadFailed": "读取失败：{message}",
      "batch.applyDone": "已应用到 {n} 个子代理，下轮请求生效",
      "batch.applyPartial": "已应用 {ok} 个，{failed} 个失败：{message}",
      "batch.applyFailed": "应用失败：{message}",
      "batch.refreshFailed": "获取最新子代理失败：{message}",
      "batch.firstError": "（{code}）"
    };

    /**
     * Translate one batch key: host translation first, then the bundled Chinese
     * fallback, then the bare key. `{name}` placeholders are interpolated.
     * A throwing `t` (bad locale bundle) must not break the card.
     */
    function batchText(t, key, vars) {
      var text = null;
      if (typeof t === "function") {
        try {
          var translated = t(key);
          if (typeof translated === "string" && translated !== "" && translated !== key) text = translated;
        } catch (_error) {
          text = null;
        }
      }
      if (text === null) {
        var fallback = Object.prototype.hasOwnProperty.call(BATCH_FALLBACK, key) ? BATCH_FALLBACK[key] : null;
        text = typeof fallback === "string" ? fallback : key;
      }
      if (vars && typeof vars === "object") {
        Object.keys(vars).forEach(function (name) {
          text = text.split("{" + name + "}").join(String(vars[name]));
        });
      }
      return text;
    }

    /** Stable option value for one `{provider, model}` pair. */
    function batchModelKey(provider, model) {
      return String(provider) + "\u0000" + String(model);
    }

    /** Split a model key back into `{provider, model}`, or null when malformed. */
    function batchSplitModelKey(key) {
      if (typeof key !== "string") return null;
      var at = key.indexOf("\u0000");
      if (at <= 0 || at === key.length - 1) return null;
      var provider = key.slice(0, at);
      var model = key.slice(at + 1);
      if (provider === "" || model === "") return null;
      return { provider: provider, model: model };
    }

    /**
     * Should the entry show at all? "present" only when the directory answered
     * and at least one row is writable. Errored, unknown, or empty responses
     * all resolve to "empty" (conservative policy: only appear when proven
     * actionable). The background presence timer and focus listener re-probe.
     */
    function batchPresence(body) {
      if (!body || body.ok !== true || !body.value || !Array.isArray(body.value.children)) return "empty";
      var rows = body.value.children;
      for (var i = 0; i < rows.length; i += 1) {
        if (rows[i] && rows[i].selectable === true) return "present";
      }
      return "empty";
    }

    /** True when a response belongs to an older request or an older session. */
    function batchRequestStale(mySeq, mySessionId, liveSeq, liveSessionId) {
      if (mySessionId !== liveSessionId) return true;
      return mySeq !== liveSeq;
    }

    /**
     * The write set of the card: every direct child the host says is writable.
     * No per-row ticking — the backend re-checks ownership for each id anyway.
     */
    function batchTargets(children) {
      var list = Array.isArray(children) ? children : [];
      var ids = [];
      for (var i = 0; i < list.length; i += 1) {
        var row = list[i];
        if (!row || row.selectable !== true) continue;
        if (typeof row.childId === "string" && row.childId !== "") ids.push(row.childId);
      }
      return ids;
    }

    /**
     * The effort dropdown for the chosen model.
     *   · capability known → catalog ids only, so a stale configured pin cannot
     *     sneak an unsupported level through;
     *   · capability unknown → only the ids this page configured, marked config;
     *   · nothing chosen → no concrete ids, and the card says to pick a model.
     */
    function batchEffortPlan(models, modelKey) {
      var list = Array.isArray(models) ? models : [];
      var single = null;
      for (var i = 0; i < list.length; i += 1) {
        var entry = list[i];
        if (!entry) continue;
        if (batchModelKey(entry.provider, entry.model) === modelKey) { single = entry; break; }
      }
      if (!single) return { choices: [], known: false, hintKey: "batch.pickModel" };
      if (single.capabilityKnown === true) {
        var catalog = Array.isArray(single.efforts) ? single.efforts : [];
        var options = catalog.map(function (effort) {
          return { id: String(effort.id), label: String(effort.label || effort.id), source: "catalog" };
        });
        if (!options.length) return { choices: [], known: true, hintKey: "batch.effortNone" };
        return { choices: options, known: true, hintKey: "" };
      }
      var pins = Array.isArray(single.configuredEfforts) ? single.configuredEfforts : [];
      var pinned = pins
        .filter(function (id) { return typeof id === "string" && id !== ""; })
        .map(function (id) { return { id: id, label: id, source: "config" }; });
      if (!pinned.length) return { choices: [], known: false, hintKey: "batch.effortUnverified" };
      return { choices: pinned, known: false, hintKey: "batch.effortUnverified" };
    }

    /**
     * Build the POST /batch/select payload for the writable ids.
     * Returns null when no model has been chosen (the card must ask, not guess).
     *   effort ""     → null strength (model default; clears an old override)
     *   effort "<id>" → that concrete level
     */
    function batchSelectionsFrom(ids, modelKey, effort) {
      var list = Array.isArray(ids) ? ids : [];
      var parsed = batchSplitModelKey(modelKey);
      if (!parsed) return null;
      var strength = effort === "" || effort === undefined || effort === null ? null : String(effort);
      return list.map(function (childId) {
        return { childId: childId, provider: parsed.provider, model: parsed.model, reasoningEffort: strength };
      });
    }

    /** Counts and the first failure of a per-item batch result, for the status line. */
    function batchResultSummary(results) {
      var list = Array.isArray(results) ? results : [];
      var failed = list.filter(function (item) { return !item || item.ok !== true; });
      var first = (failed[0] && failed[0].error) || {};
      return {
        total: list.length,
        ok: list.length - failed.length,
        failed: failed.length,
        code: String(first.code || ""),
        message: String(first.message || first.code || "unknown")
      };
    }

    /**
     * Where to paint the card: anchored to the trigger, above it when there is
     * room, flipped below when the trigger sits too high in the viewport.
     */
    function batchBoxFor(rect, viewport) {
      var vw = viewport && viewport.width ? viewport.width : 0;
      var vh = viewport && viewport.height ? viewport.height : 0;
      var top = rect && typeof rect.top === "number" ? rect.top : 0;
      var bottom = rect && typeof rect.bottom === "number" ? rect.bottom : top;
      var gap = 8;
      var width = 360;
      if (vw > 0) width = Math.max(240, Math.min(Math.min(380, Math.max(340, width)), vw - 16));
      var left = rect && typeof rect.left === "number" ? rect.left : 0;
      if (vw > 0) left = Math.max(8, Math.min(left, vw - width - 8));
      var spaceAbove = top - gap - 8;
      var spaceBelow = vh > 0 ? vh - bottom - gap : 0;
      var minUseful = 220;
      var placement = "up";
      // Only flip when the space above cannot hold a usable card AND below is better.
      if (spaceAbove < minUseful && spaceBelow > spaceAbove) placement = "down";
      if (placement === "up") {
        return {
          placement: "up",
          left: left,
          width: width,
          top: null,
          bottom: Math.max(8, (vh || 0) - top + gap),
          maxHeight: Math.min(520, Math.max(120, spaceAbove))
        };
      }
      return {
        placement: "down",
        left: left,
        width: width,
        top: bottom + gap,
        bottom: null,
        maxHeight: Math.min(520, Math.max(120, spaceBelow))
      };
    }

    function BatchSwitchEntry(props) {
      var rawSid = typeof props === "string" ? props : (props && props.sessionId);
      var sessionId = resolveCurrentSessionId(rawSid);
      // Live handle onto the host's session list store (getSnapshot +
      // subscribe). Provided by the slot inject; null means the service is
      // not reachable and presence falls back to mount/focus verification.
      var sessionsList = props && props.sessionsList && typeof props.sessionsList.getSnapshot === "function" ? props.sessionsList : null;
      var t = (props && props.t) || function (key) { return key; };
      var copy = function (key, vars) { return batchText(t, key, vars); };

      var openPair = React.useState(false);
      var isOpen = openPair[0];
      var setOpen = openPair[1];
      var snapPair = React.useState(null);
      var snapshot = snapPair[0];
      var setSnapshot = snapPair[1];
      var statusPair = React.useState({ tone: "idle", text: "" });
      var status = statusPair[0];
      var setStatus = statusPair[1];
      var modelPair = React.useState("");
      var modelKey = modelPair[0];
      var setModelKey = modelPair[1];
      var effortPair = React.useState("");
      var effort = effortPair[0];
      var setEffort = effortPair[1];
      var busyPair = React.useState("");
      var busy = busyPair[0];
      var setBusy = busyPair[1];
      var boxPair = React.useState(null);
      var box = boxPair[0];
      var setBox = boxPair[1];
      // "probing" until the directory has answered once: the entry stays out
      // of the composer until we can prove there is something to switch.
      var presencePair = React.useState("probing");
      var presence = presencePair[0];
      var setPresence = presencePair[1];

      var rootRef = React.useRef(null);
      var panelRef = React.useRef(null);
      var seqRef = React.useRef(0);
      var sidRef = React.useRef(sessionId);
      var wasOpenRef = React.useRef(false);
      var mountedRef = React.useRef(true);

      // Component lifecycle unmount guard:
      // When the host destroys this instance (e.g. via key-based conversation switch
      // or navigation away), disarm sidRef, bump seqRef and set mountedRef=false so
      // any in-flight asynchronous completions (GET or POST) are immediately dropped,
      // never fire follow-up network requests, and never update unmounted state.
      React.useEffect(function () {
        mountedRef.current = true;
        return function () {
          mountedRef.current = false;
          sidRef.current = "";
          seqRef.current += 1;
        };
      }, []);

      var children = snapshot && Array.isArray(snapshot.children) ? snapshot.children : [];
      var models = snapshot && Array.isArray(snapshot.models) ? snapshot.models : [];
      var targets = batchTargets(children);
      var plan = batchEffortPlan(models, modelKey);
      var planKey = modelKey + "|" + (plan.known ? "k" : "u") + "|" + plan.choices.length;

      var readyText = targets.length
        ? copy("batch.targets", { n: targets.length })
        : copy("batch.noTargets");
      var statusText = status.text !== "" ? status.text : readyText;
      var statusTone = status.text !== "" ? status.tone : (targets.length ? "idle" : "warn");

      // Session switch: the whole draft belongs to the old conversation, so it
      // is dropped instead of leaking into the new one.
      React.useEffect(function () {
        sidRef.current = sessionId;
        seqRef.current += 1;
        setOpen(false);
        setSnapshot(null);
        setStatus({ tone: "idle", text: "" });
        setModelKey("");
        setEffort("");
        setBusy("");
        setBox(null);
        setPresence("probing");
      }, [sessionId]);

      // Presence without a timer. The host's session list is the truth for
      // "does this conversation have children"; its snapshot only changes when
      // something actually happened. Strategy:
      // · store available → derive a signature; verify once whenever the
      //   signature changes (mount, spawn, exit) and on window focus;
      // · store unavailable → verify on mount and on focus only.
      // Either way there is no periodic request. Defenses kept from the poll
      // era: inFlight coalescing, monotonic probeSeq, alive guard.
      React.useEffect(function () {
        if (typeof sessionId !== "string" || sessionId === "") return function () { };
        if (isOpen) return function () { };
        var alive = true;
        var probeSeq = 0;
        var inFlight = null;
        var lastSignature = null;
        var verifiedOnce = false;

        function verify() {
          if (!alive) return null;
          if (inFlight !== null) return inFlight;
          if (typeof fetch !== "function") {
            setPresence("empty");
            return null;
          }
          var mySeq = ++probeSeq;
          var p = batchFetch(sessionId).then(function (body) {
            inFlight = null;
            if (!alive || mySeq !== probeSeq) return;
            setPresence(batchPresence(body));
          }).catch(function (_err) {
            inFlight = null;
            if (!alive || mySeq !== probeSeq) return;
            // Conservative policy: stay hidden on network error; the next
            // signature change or focus retries.
            setPresence("empty");
          });
          inFlight = p;
          return p;
        }

        function maybeVerify(force) {
          if (!alive) return;
          var snapshot = sessionsList ? sessionsList.getSnapshot() : null;
          var signature = snapshot !== null ? batchCatalogSignature(snapshot, sessionId) : null;
          if (force !== true) {
            // No store: only the one verification at mount, then wait for
            // focus/open — without a store there is nothing to watch and no
            // schedule to guess.
            if (signature === null) {
              if (verifiedOnce) return;
            } else if (signature === lastSignature) {
              // Nothing moved in the store: the previous answer still holds.
              return;
            }
          }
          verifiedOnce = true;
          lastSignature = signature;
          verify();
        }

        function onFocus() {
          if (!alive) return;
          // Focus is a cheap "something may have happened elsewhere" signal:
          // re-verify even when the signature looks unchanged.
          maybeVerify(true);
        }

        maybeVerify(false);

        var unsubscribe = null;
        if (sessionsList && typeof sessionsList.subscribe === "function") {
          unsubscribe = sessionsList.subscribe(function () { maybeVerify(false); });
        }

        if (typeof window !== "undefined" && window && typeof window.addEventListener === "function") {
          window.addEventListener("focus", onFocus);
        }

        return function () {
          alive = false;
          inFlight = null;
          if (typeof unsubscribe === "function") unsubscribe();
          if (typeof window !== "undefined" && window && typeof window.removeEventListener === "function") {
            window.removeEventListener("focus", onFocus);
          }
        };
      }, [sessionId, isOpen]);

      // Keep the effort choice valid for the model it applies to.
      React.useEffect(function () {
        var ids = plan.choices.map(function (choice) { return choice.id; });
        if (effort !== "" && ids.indexOf(effort) < 0) { setEffort(""); return; }
        // Directory does not report efforts but the page pinned exactly one:
        // pre-select it instead of letting "model default" pass silently.
        if (effort === "" && plan.known === false && plan.choices.length === 1) setEffort(plan.choices[0].id);
      }, [planKey]);

      // Measure the trigger while the card is open (and on scroll/resize).
      React.useEffect(function () {
        if (!isOpen) { setBox(null); return undefined; }
        function measure() {
          var viewport = typeof window === "undefined" ? null : { width: window.innerWidth, height: window.innerHeight };
          var root = rootRef.current;
          var rect = root && typeof root.getBoundingClientRect === "function" ? root.getBoundingClientRect() : null;
          if (!rect) {
            // Trigger not measurable (detached node, portal host rebuilt): anchor
            // above the bottom edge instead of refusing to open the card.
            var vh = viewport && viewport.height ? viewport.height : 0;
            var anchor = vh > 0 ? vh - 56 : 400;
            rect = { left: 16, top: anchor, bottom: anchor + 28 };
          }
          setBox(batchBoxFor(rect, viewport));
        }
        measure();
        window.addEventListener("resize", measure);
        window.addEventListener("scroll", measure, true);
        return function () {
          window.removeEventListener("resize", measure);
          window.removeEventListener("scroll", measure, true);
        };
      }, [isOpen]);

      // Dismiss on outside click / Escape.
      React.useEffect(function () {
        if (!isOpen) return undefined;
        function onPointer(event) {
          var panel = panelRef.current;
          var root = rootRef.current;
          if (panel && panel.contains(event.target)) return;
          if (root && root.contains(event.target)) return;
          setOpen(false);
        }
        function onKey(event) {
          if (event.key === "Escape") setOpen(false);
        }
        document.addEventListener("mousedown", onPointer, true);
        document.addEventListener("keydown", onKey, true);
        return function () {
          document.removeEventListener("mousedown", onPointer, true);
          document.removeEventListener("keydown", onKey, true);
        };
      }, [isOpen]);

      // Focus must come back to the trigger, not vanish into the document body.
      React.useEffect(function () {
        if (isOpen) { wasOpenRef.current = true; return; }
        if (!wasOpenRef.current) return;
        wasOpenRef.current = false;
        var root = rootRef.current;
        if (root && typeof root.focus === "function") {
          try { root.focus(); } catch (_error) { /* detached trigger */ }
        }
      }, [isOpen]);

      // True when this completion no longer belongs to what the user is looking
      // at: another conversation is on screen, a newer request superseded it,
      // or the component instance has been completely unmounted.
      function staleNow(mySeq, mySid) {
        if (!mountedRef.current) return true;
        return batchRequestStale(mySeq, mySid, seqRef.current, sidRef.current);
      }

      function fetchSnapshot() {
        if (typeof sessionId !== "string" || sessionId === "") {
          setStatus({ tone: "error", text: copy("batch.noSession") });
          return;
        }
        var mySeq = seqRef.current + 1;
        seqRef.current = mySeq;
        var mySid = sessionId;
        setBusy("load");
        batchFetch(sessionId).then(function (payload) {
          if (staleNow(mySeq, mySid)) return;
          setBusy("");
          if (!payload || typeof payload !== "object") {
            setStatus({ tone: "error", text: copy("batch.loadFailed", { message: "no response" }) });
            return;
          }
          if (payload.ok !== true) {
            var error = payload.error || {};
            var code = String(error.code || "");
            var text = code === "catalog-unavailable"
              ? copy("batch.unavailable")
              : copy("batch.loadFailed", { message: String(error.message || code || "unknown") });
            setStatus({ tone: "error", text: text });
            setSnapshot(null);
            return;
          }
          setSnapshot(payload.value || {});
        }, function (error) {
          if (staleNow(mySeq, mySid)) return;
          setBusy("");
          setStatus({ tone: "error", text: copy("batch.loadFailed", { message: String(error && error.message ? error.message : error) }) });
        });
      }

      function toggle() {
        if (isOpen) { setOpen(false); return; }
        setStatus({ tone: "idle", text: "" });
        setOpen(true);
        fetchSnapshot();
      }

      function apply() {
        if (busy !== "") return;
        if (typeof sessionId !== "string" || sessionId === "") {
          setStatus({ tone: "error", text: copy("batch.noSession") });
          return;
        }
        if (modelKey === "") { setStatus({ tone: "warn", text: copy("batch.pickModel") }); return; }
        var mySeq = seqRef.current + 1;
        seqRef.current = mySeq;
        var mySid = sessionId;
        setBusy("select");
        setStatus({ tone: "idle", text: "" });
        // The list shown in the card is a preview from open time; the conversation
        // may have gained or lost children since. Re-read before writing, and take
        // the write set from that answer alone — a stale preview must never decide
        // who gets rewritten.
        batchFetch(mySid).then(function (payload) {
          if (staleNow(mySeq, mySid)) return null;
          if (!payload || payload.ok !== true || !payload.value) {
            var readError = (payload && payload.error) || {};
            var readCode = String(readError.code || "");
            setBusy("");
            setStatus({
              tone: "error",
              text: readCode === "catalog-unavailable"
                ? copy("batch.unavailable")
                : copy("batch.refreshFailed", { message: String(readError.message || readCode || "no response") })
            });
            return null;
          }
          var fresh = payload.value;
          var freshTargets = batchTargets(Array.isArray(fresh.children) ? fresh.children : []);
          if (!freshTargets.length) {
            setSnapshot(fresh);
            setBusy("");
            setStatus({ tone: "warn", text: copy("batch.noTargets") });
            return null;
          }
          var selections = batchSelectionsFrom(freshTargets, modelKey, effort);
          if (selections === null) {
            setBusy("");
            setStatus({ tone: "warn", text: copy("batch.pickModel") });
            return null;
          }
          // Last gate before the write: if the user switched conversations while
          // the directory was in flight, nothing may be sent for the old one.
          if (staleNow(mySeq, mySid)) return null;
          setSnapshot(fresh);
          return batchPost("select", { parentSessionId: mySid, selections: selections }).then(function (written) {
            if (staleNow(mySeq, mySid)) return null;
            if (!written || written.ok !== true) {
              var writeError = (written && written.error) || {};
              setBusy("");
              setStatus({
                tone: "error",
                text: copy("batch.applyFailed", { message: String(writeError.message || writeError.code || "no response") })
              });
              return null;
            }
            var list = Array.isArray(written.value && written.value.results) ? written.value.results : [];
            list.forEach(function (item) {
              if (!item || item.ok !== true || !item.childId) return;
              var route = item.route || item;
              rememberPicked(item.childId, {
                provider: typeof route.provider === "string" ? route.provider : "",
                model: typeof route.model === "string" ? route.model : "",
                reasoningEffort: typeof route.reasoningEffort === "string" ? route.reasoningEffort : ""
              });
            });
            var summary = batchResultSummary(list);
            var code = summary.code ? copy("batch.firstError", { code: summary.code }) : "";
            if (summary.failed === 0) {
              setStatus({ tone: "ok", text: copy("batch.applyDone", { n: summary.ok }) });
            } else if (summary.ok > 0) {
              setStatus({
                tone: "error",
                text: copy("batch.applyPartial", { ok: summary.ok, failed: summary.failed, message: summary.message + code })
              });
            } else {
              setStatus({ tone: "error", text: copy("batch.applyFailed", { message: summary.message + code }) });
            }
            // Refresh so a reopened card shows the pending route; a failed read
            // must not overwrite the result we just reported.
            return batchFetch(mySid).then(function (after) {
              if (staleNow(mySeq, mySid)) return;
              if (after && after.ok === true && after.value) setSnapshot(after.value);
            }, function () { /* the write already landed; a stale read is not an error */ });
          });
        }, function (error) {
          if (staleNow(mySeq, mySid)) return;
          setBusy("");
          setStatus({
            tone: "error",
            text: copy("batch.refreshFailed", { message: String(error && error.message ? error.message : error) })
          });
        }).then(function () {
          // Every path ends here: only the conversation that started the write may
          // clear its own busy flag.
          if (staleNow(mySeq, mySid)) return;
          setBusy("");
        });
      }

      var entry = React.createElement("button", {
        type: "button",
        ref: rootRef,
        className: "dsm-batch-entry",
        title: copy("batch.entryTitle"),
        "aria-haspopup": "dialog",
        "aria-expanded": isOpen ? "true" : "false",
        onClick: toggle
      },
        React.createElement("span", { className: "dsm-batch-entry-icon", "aria-hidden": "true" }, "⇄"),
        React.createElement("span", null, copy("batch.entry"))
      );

      var panel = null;
      if (isOpen && box !== null && typeof document !== "undefined" && ReactDOM && typeof ReactDOM.createPortal === "function") {
        var effortOptions = [React.createElement("option", { key: "__default", value: "" }, copy("batch.effortDefault"))];
        plan.choices.forEach(function (choice) {
          effortOptions.push(React.createElement("option", { key: choice.id, value: choice.id },
            choice.source === "config" ? choice.label + " (配置)" : choice.label));
        });

        // `name · provider` only: where the model came from is a settings
        // concern, not something to decode mid-switch.
        var modelOptions = models.map(function (model) {
          var key = batchModelKey(model.provider, model.model);
          return React.createElement("option", { key: key, value: key },
            (model.displayName || model.model) + " · " + model.provider);
        });

        var hintKey = plan.hintKey === "batch.pickModel" ? "" : plan.hintKey;

        var panelBody = React.createElement("div", {
          ref: panelRef,
          className: "dsm-batch-panel",
          role: "dialog",
          "aria-label": copy("batch.title"),
          style: {
            position: "fixed",
            left: box.left + "px",
            width: box.width + "px",
            top: box.placement === "down" ? box.top + "px" : "auto",
            bottom: box.placement === "down" ? "auto" : box.bottom + "px",
            maxHeight: box.maxHeight + "px"
          }
        },
          React.createElement("div", { className: "dsm-batch-head" },
            React.createElement("span", { className: "dsm-batch-title" }, copy("batch.title")),
            React.createElement("button", {
              type: "button",
              className: "dsm-batch-icon-btn",
              title: copy("batch.close"),
              onClick: function () { setOpen(false); }
            }, "×")
          ),
          React.createElement("label", { className: "dsm-batch-field" },
            React.createElement("span", { className: "dsm-batch-field-label" }, copy("batch.model")),
            React.createElement("select", {
              className: "dsm-batch-select",
              value: modelKey,
              disabled: busy !== "",
              onChange: function (event) { setModelKey(event.target.value); }
            },
              React.createElement("option", { value: "" }, models.length ? copy("batch.modelPick") : copy("batch.loading")),
              modelOptions
            )
          ),
          React.createElement("label", { className: "dsm-batch-field" },
            React.createElement("span", { className: "dsm-batch-field-label" }, copy("batch.effort")),
            React.createElement("select", {
              className: "dsm-batch-select",
              value: effort,
              disabled: busy !== "",
              onChange: function (event) { setEffort(event.target.value); }
            }, effortOptions)
          ),
          hintKey !== "" ? React.createElement("div", { className: "dsm-batch-hint" }, copy(hintKey)) : null,
          React.createElement("button", {
            type: "button",
            className: "dsm-btn dsm-btn-primary dsm-batch-apply",
            disabled: busy !== "" || targets.length === 0 || modelKey === "",
            onClick: function () { apply(); }
          }, busy === "select" ? copy("batch.applying") : copy("batch.apply")),
          React.createElement("div", {
            className: "dsm-batch-status"
              + (statusTone === "error" ? " dsm-batch-status-error" : "")
              + (statusTone === "ok" ? " dsm-batch-status-ok" : ""),
            role: statusTone === "error" ? "alert" : "status"
          }, statusText)
        );

        panel = ReactDOM.createPortal(panelBody, document.body);
      }

      if (typeof sessionId !== "string" || sessionId === "") return null;
      // Nothing to switch here: keep the composer clean. An open card is never
      // pulled out from under the user, and the probe re-runs after it closes.
      if (!isOpen && presence !== "present") return null;
      return React.createElement(React.Fragment, null, entry, panel);
    }

    /** Register the batch entry on the composer's left row; returns teardown. */
    function registerBatchSwitch(ctx) {
      try {
        var regOff = null;
        var injectOff = ctx.slots.inject("conversation.input.left", function () {
          srrLog("BATCH_REGISTERING", { slot: "conversation.input.left" });
          regOff = ctx.slots.register({
            name: "conversation.input.left",
            id: "subagent-role-router-batch",
            order: 5,
            locale: SUBAGENT_ROW_LOCALE,
            inject: function (sessionIdOrProps) {
              var sid = typeof sessionIdOrProps === "string"
                ? sessionIdOrProps
                : (sessionIdOrProps && sessionIdOrProps.sessionId ? sessionIdOrProps.sessionId : undefined);
              var face = null;
              try {
                var service = typeof ctx.get === "function" ? ctx.get("sessions") : null;
                if (service && service.list && typeof service.list.getSnapshot === "function") {
                  face = {
                    getSnapshot: function () { return service.list.getSnapshot(); },
                    subscribe: function (listener) { return service.list.subscribe(listener); }
                  };
                }
              } catch (error) {
                face = null;
              }
              return { sessionId: resolveCurrentSessionId(sid), sessionsList: face };
            }
          }, BatchSwitchEntry);
          srrLog("BATCH_REGISTERED", { slot: "conversation.input.left", off: typeof regOff });
          return regOff;
        });
        return function () {
          if (typeof regOff === "function") { try { regOff(); } catch (_e) {} }
          if (typeof injectOff === "function") { try { injectOff(); } catch (_e) {} }
        };
      } catch (error) {
        console.error("[dsh-subagent-role-router] batch switch entry failed to register (slots absent):", error);
        srrLog("BATCH_REGISTER_FAILED", { message: String(error && error.message ? error.message : error) });
        return function () { };
      }
    }

    // ── apply: inject settings row ───────────────────────────────────────
    // `settingsScope` service was REMOVED in DSH 0.1.7 (settings moved to
    // `configForms` + the plugin's own `Config`). Hard-injecting it would keep
    // this whole client plugin from ever applying.
    //
    // `uiConversation` MUST be declared here, not merely read behind a guard:
    // Cordis does not return `undefined` for an undeclared service — reading
    // `ctx.uiConversation` THROWS `cannot get property "uiConversation" without
    // inject`. Because that read sits in the middle of `apply()`, the throw
    // aborted everything AFTER it — including the `ctx.inject(["configForms"])`
    // block that registers the settings card, so the Plugins page showed no
    // configuration section at all. A `if (ctx.foo && …)` guard cannot protect
    // this: evaluating `ctx.foo` is itself the failure.
    //
    // All seven official consumers (ui-chat / ui-plan / ui-deliverables / …)
    // declare it for exactly this reason. Declaring it is safe: the renderer
    // mounts this plugin only once every dependency is available, and
    // `uiConversation` ships in the same client bundle set as `slots`/`locale`,
    // so it cannot be selectively absent while those are present.
    //
    // `configForms` stays soft (via `ctx.inject`) — unlike `uiConversation` it
    // is optional by design, and `ctx.inject` is the API that waits for it
    // without throwing.
    var inject = ["slots", "locale", "uiConversation", "uiWorkspace"];

    // ── header critters: who is working right now ────────────────────────────
    //
    // One tiny SVG workstation per running subagent, in the session header
    // utilities slot (a list, so an unmounted entry leaves no gap and the
    // header keeps its width when nothing runs). Data comes from the plugin
    // half's in-memory activity ledger over the same loopback route the model
    // picker already uses.
    var CRITTERS_PATH = "subagent-role-router/activity";
    // THE DATA LEG (2.8.0): the host session store never lists ordinary
    // (non-team) subagents — its `byId` only carries sessions the conversation
    // page knows about — so the strip could never show them. The batch catalog
    // (the same endpoint the model card reads) DOES: it walks the host's own
    // subagent directory and the live agent registry. These rows are merged in
    // ADD-only: the store stays the primary source, the catalog only adds
    // children the store has never heard of, and an SSE "activity" frame from
    // the backend (child started/ended) triggers a debounced refetch instead
    // of any polling.
    var CRITTERS_BATCH_PATH = "subagent-role-router/batch";
    var CRITTERS_BATCH_REFRESH_MS = 400;
    // No polling: rows are derived from the host's own session store, which
    // the host keeps live with api-session/status pushes. The requests left
    // are one seed fetch per mount plus the catalog fetch above (mount, SSE
    // activity frames, panel open).
    var CRITTERS_MAX_STATIONS = 3;
    // The expanded panel lists at most this many rows; long-lived parents can
    // carry hundreds of ledger entries and rendering them all each second was
    // pure work for a list nobody scrolls.
    var CRITTERS_PANEL_ROWS = 40;
    var CRITTERS_EXIT_MS = 900;
    // One-shot diagnostics (module-level: survive slot remounts, reset on reload).
    var crittersDiag = { rendered: false, pollOk: false, pollFail: false, lastRows: -1, navLogged: false };
    // Panel visibility mirror (module-level, scoped to the session it was
    // opened on). The actions slot remounts children on unrelated host
    // updates, which would otherwise silently swallow an open panel and a
    // pending hover intent; the next mount reads this back instead.
    var crittersUi = { hover: false, open: false, sid: null };

    function critterRouteLabel(row) {
      var provider = row && row.provider ? row.provider : "?";
      var model = row && row.model ? row.model : "?";
      return provider + "/" + model;
    }

    function critterName(row) {
      if (row.label) return row.label;
      if (row.role) return row.role;
      return String(row.childId || "").slice(-4) || "子代理";
    }

    // The panel row used to print the raw host label ("[agent:delegated
    // review] Bounded…"), which ellipsized into unreadable fragments. Rows now
    // show one short preset phrase picked stably per childId (same child, same
    // phrase, across renders and reloads); the real label stays in the row's
    // title tooltip so the information is still there on hover.
    var CRITTER_PHRASES = [
      "努力工作", "认真思考", "埋头干活", "奋笔疾书", "稳步推进", "仔细核对",
      "专注攻坚", "默默耕耘", "全力输出", "小心求证", "加速冲刺", "认真打磨"
    ];

    function critterPhrase(row) {
      var key = String(row && row.childId ? row.childId : "");
      var hash = 0;
      for (var i = 0; i < key.length; i++) {
        hash = (hash * 31 + key.charCodeAt(i)) % 1000003;
      }
      return CRITTER_PHRASES[hash % CRITTER_PHRASES.length];
    }

    // A one-glance name for the tag under each critter and the panel's first
    // column. Host labels carry noise the user never wants there: bracketed
    // lane prefixes ("[agent:delegated review] Bounded…") and agent-teams team
    // paths ("agent-teams:<team>:<member>"). Strip both, squeeze whitespace,
    // cap the length; a label that empties out falls back to the stable preset
    // phrase so the tag is never blank. Same input, same output — no state.
    var CRITTER_TITLE_MAX = 14;

    function critterShortTitle(row) {
      var raw = row && typeof row.label === "string" ? row.label : "";
      var text = raw.replace(/\[[^\]]*\]\s*/g, " ");
      var teams = text.match(/^agent-teams:[^:]*:(.+)$/);
      if (teams) text = teams[1];
      text = text.replace(/\s+/g, " ").trim();
      if (text === "") return critterPhrase(row);
      if (text.length > CRITTER_TITLE_MAX) {
        text = text.slice(0, CRITTER_TITLE_MAX - 1) + "…";
      }
      return text;
    }

    // Hover intent windows for the header panel: how long the pointer must
    // rest on the strip before the panel opens, and how long it may dangle
    // outside before the panel closes behind it. A click-through (station
    // jump) cancels both so a just-closed panel cannot reopen by itself.
    var CRITTERS_HOVER_OPEN_MS = 300;
    var CRITTERS_HOVER_CLOSE_MS = 150;

    // ── what a panel row reports ────────────────────────────────────────────
    //
    // The row answers two questions at a glance — how long has this worker been
    // at it, and how much has it spent — so the numbers matter more than the
    // pleasantry. Both come from the host session projection (`tokenUsage`,
    // `subagentTiming`); nothing here talks to the network.

    /** The four usage buckets the host's own token total sums. */
    var CRITTER_TOKEN_BUCKETS = ["uncachedInputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"];

    /** Sum the host usage projection; null when there is no usage to sum. */
    function critterTokenTotal(usage) {
      if (!usage || typeof usage !== "object") return null;
      var total = 0;
      var seen = false;
      for (var i = 0; i < CRITTER_TOKEN_BUCKETS.length; i++) {
        var value = usage[CRITTER_TOKEN_BUCKETS[i]];
        if (typeof value !== "number" || !isFinite(value) || value <= 0) continue;
        total += value;
        seen = true;
      }
      return seen ? Math.round(total) : null;
    }

    /** Compact token count: 942 / 1.2万 / 3.4亿 — the unit Chinese readers use. */
    function formatCritterTokens(total) {
      if (typeof total !== "number" || !isFinite(total) || total < 0) return "";
      if (total >= 1e8) return trimTrailingZero((total / 1e8).toFixed(1)) + "亿";
      if (total >= 1e4) return trimTrailingZero((total / 1e4).toFixed(1)) + "万";
      return String(Math.round(total));
    }

    function trimTrailingZero(text) {
      return text.replace(/\.0$/, "");
    }

    /** Elapsed work time: 42秒 / 3分07秒 / 1小时05分. */
    function formatCritterDuration(ms) {
      if (typeof ms !== "number" || !isFinite(ms) || ms < 0) return "";
      var totalSeconds = Math.floor(ms / 1000);
      if (totalSeconds < 60) return totalSeconds + "秒";
      var minutes = Math.floor(totalSeconds / 60);
      var seconds = totalSeconds % 60;
      if (minutes < 60) return minutes + "分" + (seconds < 10 ? "0" + seconds : String(seconds)) + "秒";
      var hours = Math.floor(minutes / 60);
      var rest = minutes % 60;
      return hours + "小时" + (rest < 10 ? "0" + rest : String(rest)) + "分";
    }

    // ── six critter characters ───────────────────────────────────────────────
    //
    // Every station gets one of six pixel-art characters, all drawn on the same
    // 16x12 grid of 2px cells inside a 32x24 viewBox. The species is seeded by
    // the childId (a child never changes character between polls) and biased
    // away from the ones already on screen: three identical blobs in a row read
    // as one blob, not as three workers. (The list itself lives with the art
    // data at the top of this module — it is needed while the CSS is built.)

    /** FNV-1a over the childId: stable per id, cheap, no crypto needed. */
    function critterSeed(text) {
      var hash = 2166136261;
      var value = String(text == null ? "" : text);
      for (var i = 0; i < value.length; i++) {
        hash ^= value.charCodeAt(i);
        hash = Math.imul(hash, 16777619) >>> 0;
      }
      return hash >>> 0;
    }

    /** Pick a character for `childId`, skipping `takenKinds` when possible.
     *  Pure: same inputs, same answer. The caller remembers the result so the
     *  character survives remounts and later polls. */
    function pickCritterKind(childId, takenKinds) {
      var taken = Array.isArray(takenKinds) ? takenKinds : [];
      var free = [];
      for (var i = 0; i < CRITTER_KINDS.length; i++) {
        if (taken.indexOf(CRITTER_KINDS[i]) === -1) free.push(CRITTER_KINDS[i]);
      }
      var pool = free.length ? free : CRITTER_KINDS;
      return pool[critterSeed(childId) % pool.length];
    }

    // childId -> kind. Module-level so a slot remount or a poll gap keeps the
    // same character; entries are dropped when the station walks out.
    var critterKinds = Object.create(null);

    /** 按 CRITTER_ART 把角色画成 SVG；spin 部件包一层 <g> 好整体旋转。 */
    //
    // Art is static per (phase, kind), so the SAME immutable element descriptor
    // is handed back on every render: a header re-render no longer allocates
    // three fresh <svg> trees of ~54 <rect> each. React elements are plain
    // descriptors, so reuse across renders is safe.
    var critterArtCache = Object.create(null);
    function critterArt(phase, kind) {
      var resolved = CRITTER_KINDS.indexOf(kind) === -1 ? "maker" : kind;
      var cacheKey = String(phase) + "|" + resolved;
      var cached = critterArtCache[cacheKey];
      if (cached) return cached;
      var art = CRITTER_ART[resolved];
      var rect = function (part) {
        return React.createElement("rect", {
          className: "dsm-critter-" + resolved + "-" + part[0],
          key: part[0] + ":" + part[1] + "," + part[2],
          x: part[1], y: part[2], width: part[3], height: part[4]
        });
      };
      var spinGroup = function (key) {
        return React.createElement("g", {
          className: "dsm-critter-" + resolved + "-spin",
          key: key
        }, art.spin.map(rect));
      };
      // The rig carries the whole-body motion; ground furniture stays bolted down
      // so a hopping character does not drag its desk into the air.
      var rigChildren = [];
      if (art.spin && art.spin.length && !art.groundSpin) rigChildren.push(spinGroup("spin"));
      rigChildren = rigChildren.concat(art.parts.map(rect));
      var groundChildren = [];
      if (art.groundSpin && art.spin && art.spin.length) groundChildren.push(spinGroup("spin"));
      groundChildren = groundChildren.concat((art.ground || []).map(rect));
      var layers = [];
      if (groundChildren.length) {
        layers.push(React.createElement("g", {
          className: "dsm-critter-" + resolved + "-ground",
          key: "ground"
        }, groundChildren));
      }
      layers.push(React.createElement("g", {
        className: "dsm-critter-" + resolved + "-rig",
        key: "rig"
      }, rigChildren));
      var svg = React.createElement("svg", {
        className: "dsm-critters-art dsm-critters-art-" + resolved + (phase === "out" ? " is-leaving" : ""),
        viewBox: "0 0 32 24", width: 32, height: 24,
        "aria-hidden": "true", focusable: "false"
      }, layers);
      critterArtCache[cacheKey] = svg;
      return svg;
    }

    /** One-shot DOM census: where did we land, and what is around us. */
    function crittersCensus(tag) {
      try {
        if (typeof document === "undefined") return;
        var rect = function (el) {
          if (!el || !el.getBoundingClientRect) return null;
          var r = el.getBoundingClientRect();
          return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
        };
        var desc = function (el) {
          if (!el) return null;
          var cls = typeof el.className === "string" ? el.className : "";
          return {
            tag: el.tagName ? el.tagName.toLowerCase() : "?",
            cls: cls.slice(0, 120),
            slot: el.getAttribute ? el.getAttribute("data-slot") : null,
            text: el.textContent ? el.textContent.trim().slice(0, 24) : "",
            rect: rect(el)
          };
        };
        var root = document.querySelector("[data-subagent-critters]");
        var styleProbe = null;
        if (root && typeof window !== "undefined" && window.getComputedStyle) {
          var cs = window.getComputedStyle(root);
          var op = root.offsetParent;
          var opStyle = op && window.getComputedStyle ? window.getComputedStyle(op) : null;
          styleProbe = {
            position: cs.position,
            right: cs.right,
            top: cs.top,
            zIndex: cs.zIndex,
            offsetParent: op ? (op.tagName ? op.tagName.toLowerCase() : "?") + "." + String(op.className || "").slice(0, 40) : null,
            offsetParentPosition: opStyle ? opStyle.position : null,
            offsetParentTransform: opStyle ? opStyle.transform : null,
            sheets: document.querySelectorAll("style[data-plugin-css]").length
          };
        }
        var chain = [];
        var node = root;
        for (var i = 0; i < 8 && node; i++) { chain.push(desc(node)); node = node.parentElement; }
        var slots = [];
        var slotEls = document.querySelectorAll("[data-slot]");
        for (var j = 0; j < slotEls.length && slots.length < 40; j++) {
          var el = slotEls[j];
          var r = rect(el);
          if (!r || r.w === 0 || r.h === 0) continue;
          slots.push({ slot: el.getAttribute("data-slot"), rect: r });
        }
        var badges = [];
        var all = document.querySelectorAll("span,div,button");
        for (var k = 0; k < all.length && badges.length < 6; k++) {
          var t = all[k].textContent ? all[k].textContent.trim() : "";
          if (t === "标准模式" || t === "子智能体" || /^\d+ 个子智能体$/.test(t) || t === "12 个子智能体") {
            badges.push(desc(all[k]));
          }
        }
        var headerParts = [];
        var hEls = document.querySelectorAll('[class*="header"]');
        for (var h = 0; h < hEls.length && headerParts.length < 20; h++) {
          var hr = rect(hEls[h]);
          if (!hr || hr.w === 0 || hr.h === 0) continue;
          headerParts.push({ cls: String(hEls[h].className).slice(0, 90), rect: hr });
        }
        var badgeChain = [];
        var bnode = badges.length ? document.querySelectorAll("span,div,button") : null;
        if (bnode) {
          for (var b = 0; b < bnode.length; b++) {
            if (bnode[b].textContent && bnode[b].textContent.trim() === "标准模式") { bnode = bnode[b]; break; }
            if (b === bnode.length - 1) { bnode = null; break; }
          }
        }
        for (var c = 0; c < 6 && bnode; c++) { badgeChain.push(desc(bnode)); bnode = bnode.parentElement; }
        srrLog(tag || "CRITTERS_CENSUS", {
          headerParts: headerParts,
          badgeChain: badgeChain,
          dpr: window.devicePixelRatio,
          win: { w: window.innerWidth, h: window.innerHeight },
          root: rect(root),
          styleProbe: styleProbe,
          chain: chain,
          slots: slots,
          badges: badges,
          headerCorner: rect(document.querySelector("[data-conversation-header-corner]"))
        });
      } catch (error) {
        srrLog("CRITTERS_CENSUS_FAILED", { message: String(error && error.message ? error.message : error) });
      }
    }

    // Same-shape rows must be reported as unchanged so React can bail out of a
    // re-render; rebuilt-but-equal objects previously forced several renders a
    // second on a quiet header.
    //
    // `metrics` is false for the CLOSED header: token and settled-time movement
    // is a panel concern, and counting it as a row change rebuilt every station
    // on every projection flush (twice the component work per token update).
    // Pass true (the default) wherever the drawn output really includes them.
    function critterRowsEqual(a, b, metrics) {
      if (a === b) return true;
      if (!a || !b || a.length !== b.length) return false;
      for (var i = 0; i < a.length; i++) {
        var x = a[i];
        var y = b[i];
        if (x.childId !== y.childId || x.phase !== y.phase || x.label !== y.label || x.role !== y.role || x.provider !== y.provider || x.model !== y.model || x.startedAt !== y.startedAt) return false;
        if (metrics !== false && (x.tokens !== y.tokens || x.settledMs !== y.settledMs)) return false;
      }
      return true;
    }

    // ── store-driven rows (no polling) ──────────────────────────────────────
    // The header used to poll /activity on a timer. The host's session store
    // is the source of truth now, and these helpers only derive the picture
    // from whatever snapshot the hook hands over.
    var NO_SESSIONS_HOOK_CRITTERS = function () { return null; };
    // Unit separator: cannot occur in a host title, so the folded signature
    // stays unambiguous without any escaping rule.
    var CRITTERS_KEY_SEP = String.fromCharCode(1);
    function byIdIdentity(snap) { return snap && snap.byId ? snap.byId : null; }

    // Rows for one parent, straight from the host session snapshot — the same
    // source the native catalog dropdown reads. The store carries parentage
    // and running state; the seed (one backend fetch per mount) adds what the
    // store does not know: which model, since when. A child with no seed yet
    // still shows (store-first beats metadata) with blank route fields.
    //
    // `withMetrics` (default true) controls whether the panel numbers ride
    // along. The closed header passes false: it draws only membership and
    // character, so token movement must not change its rows.
    function deriveCritterRows(byId, parentKey, seed, withMetrics) {
      var next = [];
      if (!byId || typeof parentKey !== "string" || parentKey === "") return next;
      var includeMetrics = withMetrics !== false;
      for (var id in byId) {
        var row = byId[id];
        if (!row || row.running !== true) continue;
        var parent = row.parentId !== undefined ? row.parentId : row.parentSessionId;
        if (parent !== parentKey) continue;
        var enrich = seed && seed[id] ? seed[id] : null;
        // The host projects both numbers onto the child row; read them here so
        // the panel never needs its own request.
        var projected = row.projectionValues && typeof row.projectionValues === "object" ? row.projectionValues : null;
        var timing = projected && projected.subagentTiming && typeof projected.subagentTiming === "object" ? projected.subagentTiming : null;
        var active = timing && timing.active && typeof timing.active === "object" ? timing.active : null;
        var since = active && typeof active.since === "number" && active.since > 0 ? active.since : 0;
        var seedStartedAt = enrich && typeof enrich.startedAt === "number" ? enrich.startedAt : 0;
        // Closed header: order by the spawn time the seed pinned, so a new
        // turn's `since` cannot reshuffle (and thus re-render) the row order.
        var startedAt = includeMetrics ? (since || seedStartedAt) : (seedStartedAt || since);
        next.push({
          childId: id,
          label: row.displayTitle || (enrich && enrich.label) || "",
          role: (enrich && enrich.role) || "",
          provider: (enrich && enrich.provider) || "",
          model: (enrich && enrich.model) || "",
          startedAt: startedAt,
          settledMs: includeMetrics && timing && typeof timing.settledMs === "number" && timing.settledMs > 0 ? timing.settledMs : 0,
          tokens: includeMetrics && projected ? critterTokenTotal(projected.tokenUsage) : null,
          phase: "in"
        });
      }
      next.sort(function (a, b) {
        if (a.startedAt !== b.startedAt) return a.startedAt - b.startedAt;
        return a.childId < b.childId ? -1 : a.childId > b.childId ? 1 : 0;
      });
      return next;
    }

    // ── the narrow subscription the closed header needs ─────────────────────
    //
    // The header used to subscribe to the whole `byId` table, so every store
    // flush re-rendered it — an unrelated session's projection, or the same
    // child spending one more token, all cost a component execution. This
    // signature folds only what the CLOSED header draws: which children are
    // running under this parent, and the label shown in a tooltip. The host
    // hook compares selector results by identity, so an unchanged string means
    // no re-render at all. Numbers are deliberately absent.
    function crittersMembersKey(snap, parentKey) {
      if (!snap || !snap.byId || typeof parentKey !== "string" || parentKey === "") return "none";
      var parts = [];
      var byId = snap.byId;
      for (var id in byId) {
        var row = byId[id];
        if (!row || row.running !== true) continue;
        var parent = row.parentId !== undefined ? row.parentId : row.parentSessionId;
        if (parent !== parentKey) continue;
        parts.push(id + "|" + String(row.displayTitle || "") + "|" + String(row.origin || ""));
      }
      parts.sort();
      return parts.length === 0 ? "none" : parts.join(CRITTERS_KEY_SEP);
    }

    // Which family a page's strip shows. On a subagent's OWN page the strip
    // anchors to its parent — a child has no children, so anchoring to the
    // session itself would always read empty there. Top-level sessions anchor
    // to themselves, so the main conversation keeps its exact old picture.
    function crittersAnchorOf(byId, sid) {
      if (!byId || typeof sid !== "string" || sid === "") return sid;
      var row = byId[sid];
      if (!row || row.origin !== "subagent") return sid;
      var parent = row.parentId !== undefined ? row.parentId : row.parentSessionId;
      return typeof parent === "string" && parent !== "" ? parent : sid;
    }

    // Panel numbers for this parent's running children, keyed by childId. Read
    // only while the panel is open (one ticker, at most once a second), which
    // is why the closed header never pays for them.
    function deriveCritterMetrics(byId, parentKey) {
      var metrics = {};
      if (!byId || typeof parentKey !== "string" || parentKey === "") return metrics;
      for (var id in byId) {
        var row = byId[id];
        if (!row || row.running !== true) continue;
        var parent = row.parentId !== undefined ? row.parentId : row.parentSessionId;
        if (parent !== parentKey) continue;
        var projected = row.projectionValues && typeof row.projectionValues === "object" ? row.projectionValues : null;
        var timing = projected && projected.subagentTiming && typeof projected.subagentTiming === "object" ? projected.subagentTiming : null;
        var active = timing && timing.active && typeof timing.active === "object" ? timing.active : null;
        metrics[id] = {
          since: active && typeof active.since === "number" && active.since > 0 ? active.since : 0,
          settledMs: timing && typeof timing.settledMs === "number" && timing.settledMs > 0 ? timing.settledMs : 0,
          tokens: projected ? critterTokenTotal(projected.tokenUsage) : null
        };
      }
      return metrics;
    }

    // What could change the batch card's selectable set: the parent's catalog
    // rows (id|mode|running) or, when projections are not loaded, whatever
    // child rows the list snapshot already carries. `null` means the store is
    // unavailable — the caller then verifies once per focus instead of on a
    // timer.
    function batchCatalogSignature(snap, parentKey) {
      if (!snap || typeof parentKey !== "string" || parentKey === "") return null;
      var byId = snap.byId || {};
      var parts = [];
      var projections = snap.projectionsBySession || {};
      var projection = projections[parentKey];
      var catalog = projection && projection.values && Array.isArray(projection.values.subagentCatalog) ? projection.values.subagentCatalog : null;
      if (catalog) {
        for (var i = 0; i < catalog.length; i++) {
          var entry = catalog[i];
          if (!entry || entry.mode === "external") continue;
          var row = byId[entry.id];
          parts.push(String(entry.id) + "|" + String(entry.mode || "?") + "|" + (row && row.running === true ? "running" : "settled"));
        }
      } else {
        for (var childId in byId) {
          var candidate = byId[childId];
          if (!candidate) continue;
          var parent = candidate.parentId !== undefined ? candidate.parentId : candidate.parentSessionId;
          if (parent === parentKey) parts.push(String(childId) + "|row|" + (candidate.running === true ? "running" : "settled"));
        }
      }
      parts.sort();
      return parts.length === 0 ? "empty" : parts.join(",");
    }

    // The picker re-renders only when the answer actually moved; the signature
    // folds every field the UI reads so an identical poll is a no-op.
    function routePollSignature(value, ok, body) {
      if (!ok) return "!" + String(body && body.error ? body.error.code : "");
      return [value.provider, value.model, value.reasoningEffort, value.override ? "o" : "-", value.revision, value.pending ? "p" : "-"].join("|");
    }

    // Fold ONE child's session-store summary into a change signature (null
    // when no store snapshot was handed over). "absent" is a signature too:
    // a child appearing in / leaving the store flips it either way.
    function liveStoreSignature(snapshot, childId) {
      if (!snapshot || !snapshot.byId) return null;
      var forms = [childId];
      if (typeof childId === "string" && childId.indexOf("session-") === 0) forms.push(childId.slice(8));
      else forms.push("session-" + childId);
      var summary = null;
      for (var i = 0; i < forms.length; i++) {
        var candidate = snapshot.byId[forms[i]];
        if (candidate) { summary = candidate; break; }
      }
      if (!summary) return "absent";
      return [
        summary.running === true ? "r" : "s",
        summary.origin || "",
        summary.parentId || summary.parentSessionId || summary.parentSession || "",
        summary.updatedAt === void 0 ? "" : String(summary.updatedAt),
        summary.blank === true ? "b" : ""
      ].join("|");
    }

    /** Route ids cross the wire in both prefixed and bare form; compare canonically. */
    function canonicalSseChildId(childId) {
      var text = childId === void 0 || childId === null ? "" : String(childId);
      return text.indexOf("session-") === 0 ? text.slice(8) : text;
    }

    /**
     * Record the epoch a response carried. Returns true only when it CHANGED
     * from a previous known value — the one unambiguous reload signal.
     */
    function noteRouteEpoch(sessionId, epoch) {
      if (typeof epoch !== "string" || epoch === "") return false;
      var previous = LIVE_EPOCH_BY_SESSION[sessionId];
      LIVE_EPOCH_BY_SESSION[sessionId] = epoch;
      return previous !== void 0 && previous !== epoch;
    }

    // ── live-route SSE: cross-window route announcements ───────────────────
    // One EventSource per PAGE shared by every picker on it (ref-counted).
    // The server announces route writes and applied switches; a receiving
    // picker always answers with a GET, never trusts the payload. Three
    // consecutive hard failures degrade this page to the Stage A signal set
    // (store + focus + visibility); a 30s retry keeps trying to upgrade,
    // three tries per degradation, and success re-enables the stream.
    var liveSse = { es: null, refs: 0, listeners: [], failures: 0, retries: 0, degraded: false, retryTimer: null };

    function liveSseDeliver(event) {
      for (var i = 0; i < liveSse.listeners.length; i++) {
        try { liveSse.listeners[i](event); } catch (_e) {}
      }
    }

    function liveSseTeardown() {
      var es = liveSse.es;
      liveSse.es = null;
      if (!es) return;
      es.onopen = null;
      es.onmessage = null;
      es.onerror = null;
      try { es.close(); } catch (_e) {}
    }

    function liveSseCountFailure() {
      liveSse.failures += 1;
      if (liveSse.failures < LIVE_SSE_FAILURES_TO_DEGRADE) { liveSseScheduleRetry(); return; }
      liveSse.degraded = true;
      srrLog("SSE_FALLBACK", { reason: "closed", failures: liveSse.failures, retries: liveSse.retries });
      liveSseScheduleRetry();
    }

    function liveSseScheduleRetry() {
      if (liveSse.retryTimer || typeof setTimeout !== "function") return;
      if (liveSse.retries >= LIVE_SSE_RETRY_LIMIT) return;
      liveSse.retryTimer = setTimeout(function () {
        liveSse.retryTimer = null;
        liveSse.retries += 1;
        // NOTE: the failure count is NOT reset here — only a successful open
        // (onopen) clears it. Resetting per retry would make the
        // "three consecutive failures" ladder unreachable: each retry cycle
        // would restart from zero and the stream would never degrade.
        liveSse.degraded = false;
        if (liveSse.refs > 0) liveSseConnect();
      }, LIVE_SSE_RETRY_MS);
    }

    function liveSseConnect() {
      if (liveSse.es || liveSse.degraded) return;
      if (typeof EventSource !== "function") {
        liveSse.degraded = true;
        srrLog("SSE_FALLBACK", { reason: "no-eventsource" });
        return;
      }
      var es;
      try {
        es = new EventSource(LIVE_SSE_PATH);
      } catch (error) {
        liveSse.degraded = true;
        srrLog("SSE_FALLBACK", { reason: "constructor", message: String(error && error.message ? error.message : error) });
        return;
      }
      liveSse.es = es;
      es.onopen = function () {
        liveSse.failures = 0;
        liveSse.retries = 0;
        liveSse.degraded = false;
        // Everything the page cached may be stale after (re)connecting.
        liveSseDeliver({ type: "resync" });
      };
      es.onmessage = function (message) {
        var event = null;
        try { event = JSON.parse(message.data); } catch (_e) { return; }
        liveSseDeliver(event && typeof event === "object" ? event : null);
      };
      es.onerror = function () {
        // While CONNECTING the browser retries on its own; only a stream the
        // browser actually gave up on (CLOSED) counts as a hard failure.
        if (es.readyState === 2) {
          liveSseTeardown();
          liveSseCountFailure();
        }
      };
    }

    /**
     * Subscribe one listener to the page-level route stream. The returned
     * release function drops the subscription and tears the connection down
     * (timers included) when the last listener leaves.
     */
    function liveRouteEventsSubscribe(listener) {
      liveSse.refs += 1;
      liveSse.listeners.push(listener);
      liveSseConnect();
      return function () {
        liveSse.refs -= 1;
        if (liveSse.refs < 0) liveSse.refs = 0;
        var at = liveSse.listeners.indexOf(listener);
        if (at >= 0) liveSse.listeners.splice(at, 1);
        if (liveSse.refs === 0) {
          liveSseTeardown();
          if (liveSse.retryTimer && typeof clearTimeout === "function") {
            clearTimeout(liveSse.retryTimer);
            liveSse.retryTimer = null;
          }
        }
      };
    }

    // The age cell is pure: the panel's single ticker re-renders the rows once
    // a second, so every row reads the clock at draw time. It used to own a
    // 1s interval per row — up to 40 timers for a 40-row panel. Unknown start
    // times show a dash instead of an invented age.
    function CritterAge(props) {
      var startedAt = props.startedAt;
      var settledMs = typeof props.settledMs === "number" && props.settledMs > 0 ? props.settledMs : 0;
      if (typeof startedAt !== "number" || startedAt <= 0) return settledMs > 0 ? formatCritterDuration(settledMs) : null;
      // Settled turns plus the current one, the same arithmetic the host's own
      // subagent list uses.
      return formatCritterDuration(settledMs + Math.max(0, Date.now() - startedAt));
    }

    function HeaderCritters(props) {
      var propsSid = typeof props === "string" ? props : (props && props.sessionId);
      var sessionId = resolveCurrentSessionId(propsSid);
      // The standard kit hands session-scoped entries a useSessions selector
      // hook; when it is missing everything degrades to "no rows" instead of
      // inventing state. The hook object is stable per mount, so the branch
      // never flips under React's feet.
      var useSessionsHook = typeof props.useSessions === "function" ? props.useSessions : NO_SESSIONS_HOOK_CRITTERS;
      // A live handle onto the host session list, handed in by the slot inject.
      // The membership signature decides WHEN this component renders; this
      // handle decides WHAT to read at that moment, without subscribing to the
      // whole table. Without a handle, the old whole-table subscription stays
      // as the fallback path.
      var sessionsList = props && props.sessionsList && typeof props.sessionsList.getSnapshot === "function" ? props.sessionsList : null;
      var sidRef = React.useRef(sessionId);
      sidRef.current = sessionId;
      var membersSelectorRef = React.useRef(null);
      if (!membersSelectorRef.current) {
        // The watched membership is the ANCHOR family's (a child page watches
        // its parent's children), so navigating parent ↔ child re-derives.
        membersSelectorRef.current = function (snap) {
          return crittersMembersKey(snap, crittersAnchorOf(snap && snap.byId ? snap.byId : null, sidRef.current));
        };
      }
      var membersKey = useSessionsHook(sessionsList ? membersSelectorRef.current : NO_SESSIONS_HOOK_CRITTERS);
      var fallbackById = useSessionsHook(sessionsList ? NO_SESSIONS_HOOK_CRITTERS : byIdIdentity);
      var readById = function () {
        if (sessionsList) {
          var snap = null;
          try { snap = sessionsList.getSnapshot(); } catch (_e) { snap = null; }
          return snap && snap.byId ? snap.byId : null;
        }
        return fallbackById;
      };
      var rowsState = React.useState([]);
      var rows = rowsState[0];
      var setRows = rowsState[1];
      // Panel numbers live in their own state, filled only while the panel is
      // open (see the ticker below) — never on the closed header's path.
      var metricsState = React.useState(null);
      var metrics = metricsState[0];
      var setMetrics = metricsState[1];
      var openState = React.useState(crittersUi.open === true && crittersUi.sid === sidRef.current);
      var open = openState[0];
      var setOpenRaw = openState[1];
      // Every close/open goes through this mirror so the state survives the
      // actions slot remounting children (see crittersUi above).
      var setUiOpen = function (value) {
        crittersUi.open = value === true;
        if (crittersUi.open) crittersUi.sid = sidRef.current;
        setOpenRaw(crittersUi.open);
      };
      var seedState = React.useState(null);
      var seed = seedState[0];
      var setSeed = seedState[1];
      // The catalog leg's rows, reshaped into the same forms the derivation
      // already consumes: `seed` rows (label/route/since) and synthetic `byId`
      // entries (running + parent) for children the host store has never heard
      // of. Null until the first fetch lands.
      var batchState = React.useState(null);
      var batch = batchState[0];
      var setBatch = batchState[1];
      // First-sight clock for catalog rows (they carry no start time), stable
      // across refetches so an age never jumps.
      var batchFirstSeenRef = React.useRef({});
      // Set by the catalog effect so the panel-open path can force a refresh.
      var batchFetchRef = React.useRef(null);
      var animPausedState = React.useState(false);
      var animPaused = animPausedState[0];
      var setAnimPaused = animPausedState[1];
      var exitsRef = React.useRef([]);
      var rootRef = React.useRef(null);
      // One pending hover-intent timer for the whole strip (open or close).
      var hoverTimerRef = React.useRef(0);
      var panelPosState = React.useState(null);
      var panelPos = panelPosState[0];
      var setPanelPos = panelPosState[1];

      // Anchor the station to the title row's right edge by MEASURING it.
      // The old build hard-coded fixed right:28px/top:47px, which drifted out
      // of the row as soon as the host grew chrome above the conversation
      // (tab bar). Walk up from the slot to the first visible row, then pin
      // to its live box; values are written only when they change, so the
      // observer cannot loop on its own writes. No measurement (SSR, tests,
      // detached tree) simply keeps the root in normal flow.
      React.useEffect(function () {
        var root = rootRef.current;
        if (!root || typeof window === "undefined" || !window) return undefined;
        var CRITTER_HEIGHT = 24;
        var frame = 0;
        var anchor = function () {
          frame = 0;
          var row = root.parentElement;
          var rect = null;
          while (row && row !== document.body) {
            var box = row.getBoundingClientRect();
            if (box.height > 0 && box.width > 0) { rect = box; break; }
            row = row.parentElement;
          }
          if (!rect) {
            if (root.classList.contains("is-anchored")) root.classList.remove("is-anchored");
            return;
          }
          var rightPx = Math.max(8, Math.round(window.innerWidth - rect.right)) + "px";
          var topPx = Math.max(0, Math.round(rect.top + (rect.height - CRITTER_HEIGHT) / 2)) + "px";
          if (!root.classList.contains("is-anchored")) root.classList.add("is-anchored");
          if (root.style.right !== rightPx) root.style.right = rightPx;
          if (root.style.top !== topPx) root.style.top = topPx;
        };
        var schedule = function () {
          if (frame) return;
          if (typeof requestAnimationFrame === "function") frame = requestAnimationFrame(anchor);
          else anchor();
        };
        schedule();
        window.addEventListener("resize", schedule);
        window.addEventListener("scroll", schedule, true);
        var observer = null;
        if (typeof ResizeObserver === "function") {
          observer = new ResizeObserver(schedule);
          observer.observe(document.body);
          if (root.parentElement) observer.observe(root.parentElement);
        }
        return function () {
          if (frame && typeof cancelAnimationFrame === "function") cancelAnimationFrame(frame);
          window.removeEventListener("resize", schedule);
          window.removeEventListener("scroll", schedule, true);
          if (observer) observer.disconnect();
        };
      }, []);

      // The panel used to be absolutely positioned inside the station, and the
      // host's actions row clips its children (fixed height, overflow hidden),
      // so the menu lost its left column AND its lower rows. Position it
      // against the viewport instead: fixed escapes that clip box, and every
      // open re-measures, so the panel stays whole and inside the window on
      // resize, scroll and layout churn. A missing measurement keeps the CSS
      // fallback rather than guessing coordinates.
      React.useEffect(function () {
        if (!open) return undefined;
        if (typeof window === "undefined" || !window) return undefined;
        var frame = 0;
        var logged = false;
        var PANEL_MAX = 420;
        var PANEL_MIN = 120;
        var place = function () {
          frame = 0;
          var root = rootRef.current;
          if (!root || typeof root.getBoundingClientRect !== "function") return;
          var rect = root.getBoundingClientRect();
          var vw = window.innerWidth || 0;
          var vh = window.innerHeight || 0;
          if (vw <= 0 || vh <= 0) return;
          var width = Math.min(320, Math.max(200, vw - 16));
          var right = Math.max(8, Math.round(vw - rect.right));
          var top = Math.round(rect.bottom + 8);
          if (top > vh - PANEL_MIN) top = Math.max(8, Math.round(rect.top - PANEL_MIN - 8));
          var maxHeight = Math.max(PANEL_MIN, Math.min(PANEL_MAX, vh - top - 12));
          if (!logged) {
            logged = true;
            // One line per open tells us what actually clips the slot, in case
            // a future host wraps the row in a transform (which would trap a
            // fixed child as well).
            var clipped = [];
            var node = root.parentElement;
            while (node && node !== document.body && clipped.length < 4) {
              var style = typeof window.getComputedStyle === "function" ? window.getComputedStyle(node) : null;
              if (style) {
                if (style.overflow !== "visible" || style.overflowY !== "visible" || style.overflowX !== "visible") {
                  clipped.push(String(node.className || node.tagName) + ":overflow=" + style.overflow + "/" + style.overflowY);
                }
                if (style.transform !== "none" || style.filter !== "none") {
                  clipped.push(String(node.className || node.tagName) + ":xf");
                }
              }
              node = node.parentElement;
            }
            srrLog("CRITTERS_PANEL_ANCHOR", { right: right, top: top, width: width, maxHeight: maxHeight, clipped: clipped });
          }
          setPanelPos(function (prev) {
            if (prev && prev.right === right && prev.top === top && prev.width === width && prev.maxHeight === maxHeight) return prev;
            return { position: "fixed", right: right, top: top, width: width, maxHeight: maxHeight };
          });
        };
        var schedule = function () {
          if (frame) return;
          if (typeof requestAnimationFrame === "function") frame = requestAnimationFrame(place);
          else place();
        };
        schedule();
        window.addEventListener("resize", schedule);
        window.addEventListener("scroll", schedule, true);
        return function () {
          if (frame && typeof cancelAnimationFrame === "function") cancelAnimationFrame(frame);
          window.removeEventListener("resize", schedule);
          window.removeEventListener("scroll", schedule, true);
        };
      }, [open]);

      // One seed fetch per mount: route metadata (which model, since when)
      // for the children the store shows. Never rescheduled — the store
      // drives everything after this.
      React.useEffect(function () {
        if (typeof sessionId !== "string" || sessionId === "") return void 0;
        if (typeof fetch !== "function") return void 0;
        var alive = true;
        // Seed the ANCHOR family: on a child page the strip shows the parent's
        // children, so their metadata (which model, since when) lives under
        // the parent's id.
        var seedAnchor = crittersAnchorOf(readById(), sessionId);
        liveRouteRequest(
          CRITTERS_PATH + "?parentSessionId=" + encodeURIComponent(seedAnchor),
          { method: "GET", cache: "no-store" }
        ).then(function (body) {
          if (!alive || !body || body.ok !== true) return;
          var map = {};
          var list = body.value && Array.isArray(body.value.active) ? body.value.active : [];
          for (var i = 0; i < list.length; i++) {
            var row = list[i];
            if (row && typeof row.childId === "string") map[row.childId] = row;
          }
          setSeed(map);
        }).catch(function () { });
        return function () { alive = false; };
      }, [sessionId]);

      // The catalog leg: one fetch per mount, a debounced refetch on every
      // "activity" SSE frame (a child started or ended somewhere), and a
      // refresh when the panel opens. Rows the host store already knows are
      // IGNORED here — the store is the primary source and its rows carry the
      // real projections; the catalog only contributes children the store has
      // never heard of (ordinary subagents live outside it). No polling.
      React.useEffect(function () {
        if (typeof sessionId !== "string" || sessionId === "") return void 0;
        if (typeof fetch !== "function") return void 0;
        var alive = true;
        var timer = 0;
        var fetchBatch = function () {
          // The anchor is read at fetch time: navigating parent ↔ child
          // re-derives, and rows keyed to the old anchor simply stop matching.
          var anchorNow = crittersAnchorOf(readById(), sessionId);
          if (typeof anchorNow !== "string" || anchorNow === "") return;
          liveRouteRequest(
            CRITTERS_BATCH_PATH + "?parentSessionId=" + encodeURIComponent(anchorNow),
            { method: "GET", cache: "no-store" }
          ).then(function (body) {
            if (!alive || !body || body.ok !== true) return;
            var list = body.value && Array.isArray(body.value.children) ? body.value.children : [];
            var seedRows = {};
            var synthRows = {};
            for (var i = 0; i < list.length; i++) {
              var row = list[i];
              if (!row || typeof row.childId !== "string" || row.childId === "") continue;
              // Running only: the strip shows who is working right now, and
              // the catalog reports residency (`live`) separately from
              // activity (`activity === "running"`). Rows the store will
              // render itself are skipped too — no double drawing, and their
              // richer projections win.
              if (row.live !== true || row.activity !== "running") continue;
              var childId = row.childId;
              if (batchFirstSeenRef.current[childId] === undefined) {
                batchFirstSeenRef.current[childId] = Date.now();
              }
              seedRows[childId] = {
                childId: childId,
                parentSessionId: anchorNow,
                label: typeof row.label === "string" ? row.label : "",
                role: typeof row.reason === "string" && row.reason !== "ok" ? row.reason : "",
                provider: typeof row.provider === "string" ? row.provider : "",
                model: typeof row.model === "string" ? row.model : "",
                startedAt: batchFirstSeenRef.current[childId]
              };
              synthRows[childId] = { running: true, parentId: anchorNow };
            }
            setBatch({ seed: seedRows, synth: synthRows });
          }).catch(function () { });
        };
        batchFetchRef.current = fetchBatch;
        var scheduleBatchRefresh = function () {
          if (timer) clearTimeout(timer);
          timer = setTimeout(function () {
            timer = 0;
            fetchBatch();
          }, CRITTERS_BATCH_REFRESH_MS);
        };
        // One listener on the page-level stream; only child start/end frames
        // matter here. Route/override frames are ignored — the store covers
        // those children and their membership signature already re-renders.
        var release = liveRouteEventsSubscribe(function (event) {
          if (event && typeof event === "object" && event.type === "activity") scheduleBatchRefresh();
        });
        fetchBatch();
        return function () {
          alive = false;
          batchFetchRef.current = null;
          release();
          if (timer) clearTimeout(timer);
        };
      }, [sessionId]);

      // Rows come from the host's session store, re-derived only when the
      // MEMBERSHIP of this parent's running children changes (that is what the
      // subscription above watches). A token or timing flush no longer reaches
      // this effect, so the stations are not rebuilt for a number nobody sees.
      // A missing or empty picture walks existing rows out through the same
      // exit animation as before. The enabled flag is read here (not in deps)
      // so flipping it takes effect on the next relevant flush.
      React.useEffect(function () {
        var alive = true;
        var merge = function (next) {
          if (!alive) return;
          setRows(function (prev) {
            var pending = {};
            for (var i = 0; i < next.length; i++) pending[next[i].childId] = next[i];
            var out = [];
            for (var j = 0; j < prev.length; j++) {
              var old = prev[j];
              var fresh = pending[old.childId];
              if (fresh) {
                out.push({ childId: old.childId, label: fresh.label, role: fresh.role, provider: fresh.provider, model: fresh.model, startedAt: fresh.startedAt, phase: "in" });
                delete pending[old.childId];
              } else if (old.phase !== "out") {
                out.push({ childId: old.childId, label: old.label, role: old.role, provider: old.provider, model: old.model, startedAt: old.startedAt, phase: "out" });
                (function (gone) {
                  exitsRef.current.push(setTimeout(function () {
                    setRows(function (cur) {
                      return cur.filter(function (row) { return !(row.childId === gone && row.phase === "out"); });
                    });
                  }, CRITTERS_EXIT_MS));
                })(old.childId);
              } else {
                out.push(old);
              }
            }
            for (var key in pending) {
              var row = pending[key];
              out.push({ childId: row.childId, label: row.label, role: row.role, provider: row.provider, model: row.model, startedAt: row.startedAt, phase: "in" });
            }
            // Equality check: an unchanged picture must return the SAME array
            // so React bails out instead of re-rendering the header.
            return critterRowsEqual(prev, out, false) ? prev : out;
          });
        };
        var byIdNow = readById();
        // The catalog leg joins here: synthetic store-shaped entries carry the
        // children the host store has never heard of (ordinary subagents), and
        // the catalog's seed rows enrich them. The store wins on every key it
        // covers; the ledger seed beats the catalog's first-sight clock.
        var synthById = batch && batch.synth ? batch.synth : null;
        var mergedById = synthById ? (byIdNow ? Object.assign({}, synthById, byIdNow) : synthById) : byIdNow;
        var mergedSeed = Object.assign({}, batch && batch.seed ? batch.seed : null, seed);
        merge(!isCrittersEnabled() ? [] : deriveCritterRows(mergedById, crittersAnchorOf(mergedById, sessionId), mergedSeed, false));
        return function () { alive = false; };
      }, [sessionId, membersKey, fallbackById, seed, batch]);

      // Number refresh: one ticker for the whole panel, only while it is open,
      // at most once a second. It re-reads the store at that moment instead of
      // keeping projections in the render path, so closed panels cost nothing
      // and an open one costs one render per second at most.
      React.useEffect(function () {
        if (!open) {
          setMetrics(null);
          return undefined;
        }
        var refresh = function () {
          var byIdNow = readById();
          setMetrics(deriveCritterMetrics(byIdNow, crittersAnchorOf(byIdNow, sessionId)));
        };
        // Opening the panel is a good moment to re-ask the catalog: rows are
        // merged add-only, so a stale/empty catalog can never hide store rows.
        if (batchFetchRef.current) batchFetchRef.current();
        refresh();
        var timer = setInterval(refresh, 1000);
        return function () { clearInterval(timer); };
      }, [open, sessionId, membersKey, seed]);

      // Exit timers outlive effect re-runs (a re-run must not cancel an
      // in-flight walk-out), so they are cleared only when the component
      // unmounts for good.
      React.useEffect(function () {
        return function () {
          var pending = exitsRef.current;
          for (var i = 0; i < pending.length; i++) clearTimeout(pending[i]);
          exitsRef.current.length = 0;
          if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
          hoverTimerRef.current = 0;
        };
      }, []);

      // The actions slot remounts children on unrelated host updates; the
      // pending hover-open timer dies with the old mount. If the pointer was
      // resting on the strip when that happened, re-arm the open timer so
      // the panel still appears instead of demanding a fresh enter. Registered
      // below the hover helpers so the closure sees them assigned in any
      // effect executor, inline or deferred.

      // Pause the CSS animations while the window is hidden: the browser
      // throttles timers anyway, but style work for a hidden header is pure
      // waste.
      React.useEffect(function () {
        if (typeof document === "undefined" || typeof document.addEventListener !== "function") return void 0;
        var sync = function () { setAnimPaused(document.hidden === true); };
        sync();
        document.addEventListener("visibilitychange", sync);
        return function () { document.removeEventListener("visibilitychange", sync); };
      }, []);

      // One-shot placement census (diagnostic): logs where the header put us
      // and which slots are around, so the slot choice is measured, not
      // guessed. Only when debug logging is on — it used to measure the DOM
      // on every mount even in quiet mode.
      React.useEffect(function () {
        if (typeof window !== "undefined") window.__dsmCrittersCensus = crittersCensus;
        if (!srrDebugEnabled()) return void 0;
        var timer = setTimeout(function () { crittersCensus("CRITTERS_CENSUS_MOUNT"); }, 600);
        return function () { clearTimeout(timer); };
      }, []);

      // Click outside closes the list.
      React.useEffect(function () {
        if (!open) return void 0;
        var onDown = function (event) {
          var root = rootRef.current;
          if (root && event.target && root.contains(event.target)) return;
          setUiOpen(false);
        };
        document.addEventListener("mousedown", onDown, true);
        return function () { document.removeEventListener("mousedown", onDown, true); };
      }, [open]);

      // Hover intent, not hover toggle: resting on the strip opens the panel
      // after a short delay; leaving closes it after a shorter one. Moving
      // from the strip into the panel never fires "leave" (the panel is a DOM
      // child of this root), so the gap crossing cannot flicker it closed.
      // Keyboard focus opens it the same way; Esc closes. These helpers are
      // plain vars (no hooks) and sit above the empty-state early returns so
      // the re-arm effect below can call them regardless of render path.
      var clearHoverTimer = function () {
        if (!hoverTimerRef.current) return;
        clearTimeout(hoverTimerRef.current);
        hoverTimerRef.current = 0;
      };
      var schedulePanelOpen = function () {
        clearHoverTimer();
        hoverTimerRef.current = setTimeout(function () {
          hoverTimerRef.current = 0;
          setUiOpen(true);
        }, CRITTERS_HOVER_OPEN_MS);
      };
      var schedulePanelClose = function () {
        clearHoverTimer();
        hoverTimerRef.current = setTimeout(function () {
          hoverTimerRef.current = 0;
          setUiOpen(false);
        }, CRITTERS_HOVER_CLOSE_MS);
      };

      // See the remount note above the visibility effect: re-arm on mount.
      // This hook MUST sit above the empty-state early returns below — a hook
      // declared after `return null` disappears on the first (empty) render
      // and reappears once rows arrive, which is React error #310 ("rendered
      // more hooks than during the previous render") and the slot boundary
      // then permanently abdicates the whole strip.
      React.useEffect(function () {
        if (crittersUi.hover === true && crittersUi.sid === sidRef.current && !hoverTimerRef.current) {
          schedulePanelOpen();
        }
      }, []);

      if (typeof window !== "undefined" && rows.length === 0) window.__dsmCensusDone = 0;
      if (!isCrittersEnabled()) return null;
      if (rows.length === 0) return null;
      // First render with rows: log synchronously (a delayed timer would be
      // cleared by the actions slot remounting children on unrelated updates).
      if (!crittersDiag.rendered) {
        crittersDiag.rendered = true;
        srrLog("CRITTERS_RENDER_ROWS", { count: rows.length });
      }
      if (typeof window !== "undefined" && window.__dsmCrittersCensus && srrDebugEnabled() && window.__dsmCensusDone !== rows.length) {
        window.__dsmCensusDone = rows.length;
        setTimeout(function () { window.__dsmCrittersCensus("CRITTERS_CENSUS_ROWS"); }, 200);
      }

      // Clicking a critter jumps to that subagent's conversation directly —
      // the panel is a hover launcher, so the jump must not depend on it.
      // Defined before the stations map because every station needs it.
      // A dead click is the worst outcome: when navigation is unavailable or
      // the jump fails, fall back to opening the panel so the click still
      // does something visible.
      var openChild = function (childId) {
        clearHoverTimer();
        var jumped = false;
        if (typeof props.openSession === "function" && typeof childId === "string" && childId !== "") {
          try {
            jumped = props.openSession(childId) === true;
          } catch (error) {
            jumped = false;
            srrLog("CRITTERS_OPEN_FAILED", { childId: childId, message: String(error && error.message ? error.message : error) });
          }
        }
        if (jumped) {
          setUiOpen(false);
          return;
        }
        srrLog("CRITTERS_OPEN_NO_NAV", { childId: childId, hasNav: typeof props.openSession === "function" });
        setUiOpen(true);
      };
      // The anchor family id at render time decides both the "↩ 主对话" chip
      // (only a child page has one) and where it goes. A plain read, no extra
      // subscription — the membership signature above already watches it.
      var anchorNow = crittersAnchorOf(readById(), sessionId);
      var goBack = function (anchorId) {
        clearHoverTimer();
        if (typeof props.openParent === "function" && typeof anchorId === "string" && anchorId !== "") {
          props.openParent(anchorId);
        }
      };
      var stations = rows.slice(0, CRITTERS_MAX_STATIONS).map(function (row, index) {
        var kind = critterKinds[row.childId];
        if (!kind) {
          var taken = [];
          for (var i = 0; i < rows.length; i++) {
            if (rows[i] === row) continue;
            var other = critterKinds[rows[i].childId];
            if (other && taken.indexOf(other) === -1) taken.push(other);
          }
          kind = pickCritterKind(row.childId, taken);
          critterKinds[row.childId] = kind;
        }
        var shortTitle = critterShortTitle(row);
        var fullName = critterName(row);
        return React.createElement("button", {
          type: "button",
          className: "dsm-critters-station",
          key: row.childId,
          "data-critter": index,
          "data-critter-kind": kind,
          "data-critter-title": shortTitle,
          "aria-label": "打开" + fullName + "的对话",
          title: fullName + "（点击打开这个子代理的对话）",
          onClick: function (event) {
            if (event && typeof event.preventDefault === "function") event.preventDefault();
            openChild(row.childId);
          },
          onKeyDown: function (event) {
            var key = event && event.key;
            if (key !== "Enter" && key !== " ") return;
            if (event && typeof event.preventDefault === "function") event.preventDefault();
            openChild(row.childId);
          }
        },
          critterArt(row.phase, kind),
          React.createElement("span", { className: "dsm-critters-tag" }, shortTitle)
        );
      });
      // Leaving rows are gone for good: drop their character slot so a later
      // child can reuse the species without fighting a stale assignment.
      var liveIds = {};
      for (var liveIndex = 0; liveIndex < rows.length; liveIndex++) liveIds[rows[liveIndex].childId] = true;
      for (var knownId in critterKinds) {
        if (!liveIds[knownId]) delete critterKinds[knownId];
      }
      var hidden = rows.length - stations.length;
      if (hidden > 0) {
        stations.push(React.createElement("button", {
          type: "button",
          className: "dsm-critters-more",
          key: "more",
          "aria-label": "还有 " + hidden + " 个子代理，打开完整列表",
          onClick: function (event) {
            if (event && typeof event.preventDefault === "function") event.preventDefault();
            setUiOpen(true);
          }
        }, "+" + hidden));
      }

      var panelStyle = panelPos
        ? { position: "fixed", right: panelPos.right + "px", top: panelPos.top + "px", maxWidth: panelPos.width + "px", maxHeight: panelPos.maxHeight + "px" }
        : undefined;
      var panel = null;
      if (open) {
        panel = React.createElement("div", { className: "dsm-critters-panel", style: panelStyle, role: "dialog", "aria-label": "正在运行的子代理" },
          React.createElement("div", { className: "dsm-critters-panel-title" }, "正在运行 " + rows.length + " 个子代理" + (rows.length > CRITTERS_PANEL_ROWS ? "（只显示前 " + CRITTERS_PANEL_ROWS + " 个）" : "")),
          rows.slice(0, CRITTERS_PANEL_ROWS).map(function (row) {
            // Numbers come from the panel ticker's metric map, not from the row:
            // that keeps them out of the closed header's render path. Unknown
            // route/start fields are omitted instead of printing "?/?" and "—":
            // the seed arrives once per mount, and a practically empty trailing
            // column reads as noise.
            var metric = metrics && metrics[row.childId] ? metrics[row.childId] : null;
            var startedAt = metric && metric.since > 0 ? metric.since : row.startedAt;
            var settledMs = metric && typeof metric.settledMs === "number" ? metric.settledMs : 0;
            var metricTokens = metric && typeof metric.tokens === "number" ? metric.tokens : null;
            var routeKnown = !!(row.provider || row.model);
            var durationKnown = (typeof startedAt === "number" && startedAt > 0) || settledMs > 0;
            var tokenText = typeof metricTokens === "number" ? formatCritterTokens(metricTokens) : "";
            return React.createElement("div", {
              className: "dsm-critters-row",
              key: row.childId,
              role: "button",
              tabIndex: 0,
              title: critterName(row) + (routeKnown ? " · " + critterRouteLabel(row) : "") + "（点击打开这个子代理的对话）",
              onClick: function () { openChild(row.childId); },
              onKeyDown: function (event) {
                var key = event && event.key;
                if (key !== "Enter" && key !== " ") return;
                if (typeof event.preventDefault === "function") event.preventDefault();
                openChild(row.childId);
              }
            },
              React.createElement("span", { className: "dsm-critters-row-name" }, critterShortTitle(row)),
              durationKnown ? React.createElement("span", { className: "dsm-critters-row-age" }, React.createElement(CritterAge, { startedAt: startedAt, settledMs: settledMs })) : null,
              tokenText ? React.createElement("span", { className: "dsm-critters-row-tokens" }, tokenText + " tokens") : null
            );
          })
        );
      }

      return React.createElement("span", {
        className: "dsm-critters",
        ref: rootRef,
        "data-subagent-critters": "",
        "data-count": rows.length,
        "data-anim-paused": animPaused ? "1" : "0",
        onMouseEnter: function () {
          crittersUi.hover = true;
          crittersUi.sid = sidRef.current;
          schedulePanelOpen();
        },
        onMouseLeave: function () {
          crittersUi.hover = false;
          schedulePanelClose();
        },
        onFocus: schedulePanelOpen,
        onKeyDown: function (event) {
          if (event && event.key === "Escape") setUiOpen(false);
        }
      },
        React.createElement("span", { className: "dsm-critters-btn" },
          anchorNow !== sessionId && anchorNow
            ? React.createElement("button", {
                type: "button",
                className: "dsm-critters-back",
                key: "back",
                "aria-label": "回到主对话",
                title: "回到主对话",
                onClick: function (event) {
                  if (event && typeof event.preventDefault === "function") event.preventDefault();
                  goBack(anchorNow);
                }
              }, "↩ 主对话")
            : null,
          stations
        ),
        panel
      );
    }

    /** Register the critters in the session header actions slot. */
    function registerHeaderCritters(ctx) {
      try {
        var regOff = null;
        var injectOff = ctx.slots.inject("conversation.session.header.actions", function () {
          regOff = ctx.slots.register({
            name: "conversation.session.header.actions",
            id: "subagent-role-router-critters",
            order: 15,
            locale: SUBAGENT_ROW_LOCALE,
            inject: function (sessionIdOrProps) {
              var sid = typeof sessionIdOrProps === "string"
                ? sessionIdOrProps
                : (sessionIdOrProps && sessionIdOrProps.sessionId ? sessionIdOrProps.sessionId : undefined);
              // Host navigation service: the same call the host's own subagent
              // catalog uses to open a child (ctx.uiWorkspace.openSession).
              var navigation = null;
              try { navigation = typeof ctx.get === "function" ? ctx.get("uiWorkspace") : ctx.uiWorkspace; } catch (_e) { navigation = null; }
              if (!crittersDiag.navLogged) {
                crittersDiag.navLogged = true;
                srrLog("CRITTERS_NAV_STATUS", { present: Boolean(navigation), openSession: navigation ? typeof navigation.openSession : "none" });
              }
              // Live handle onto the session list: the component reads `byId`
              // from it at render/effect time and subscribes through the
              // slot's own useSessions hook with a narrow selector.
              var sessionsService = null;
              try { sessionsService = typeof ctx.get === "function" ? ctx.get("sessions") : null; } catch (_e) { sessionsService = null; }
              var list = sessionsService && sessionsService.list;
              var sessionsFace = list && typeof list.getSnapshot === "function" && typeof list.subscribe === "function"
                ? { getSnapshot: function () { return list.getSnapshot(); }, subscribe: function (cb) { return list.subscribe(cb); } }
                : null;
              var resolvedSid = resolveCurrentSessionId(sid);
              return {
                sessionId: resolvedSid,
                sessionsList: sessionsFace,
                openSession: function (childId) {
                  if (!navigation || typeof navigation.openSession !== "function") return false;
                  // The host's own subagent catalog opens children with the
                  // full address object ({parentSessionId, childSessionId,
                  // mode}); a bare child id is not a top-level workspace
                  // session and is silently ignored. On a child page the
                  // strip shows the ANCHOR family, so both the catalog
                  // projection and the address's parent come from the anchor,
                  // not the page we sit on. Running children default to
                  // "continuable" — the same value the host's own stop path
                  // hard-codes.
                  var anchorId = resolvedSid;
                  var mode = "continuable";
                  try {
                    var snap = list && typeof list.getSnapshot === "function" ? list.getSnapshot() : null;
                    anchorId = crittersAnchorOf(snap && snap.byId ? snap.byId : null, resolvedSid);
                    var projection = snap && snap.projectionsBySession && anchorId ? snap.projectionsBySession[anchorId] : null;
                    var entries = projection && projection.values ? projection.values.subagentCatalog : null;
                    if (entries) {
                      for (var i = 0; i < entries.length; i++) {
                        var entry = entries[i];
                        if (entry && entry.id === childId && entry.mode) { mode = entry.mode; break; }
                      }
                    }
                  } catch (_e) { /* keep the default */ }
                  try {
                    navigation.openSession({ parentSessionId: anchorId, childSessionId: childId, mode: mode });
                    return true;
                  } catch (error) {
                    srrLog("CRITTERS_OPEN_FAILED", { childId: childId, message: String(error && error.message ? error.message : error) });
                    return false;
                  }
                },
                // Back to the family's main conversation. The parent IS a
                // top-level workspace session, so the bare-id form the host's
                // own breadcrumb uses is correct here (unlike child jumps).
                openParent: function (parentId) {
                  if (!navigation || typeof navigation.openSession !== "function") {
                    srrLog("CRITTERS_BACK_NO_NAV", { parentId: String(parentId || ""), hasNav: false });
                    return false;
                  }
                  try {
                    navigation.openSession(parentId);
                    return true;
                  } catch (error) {
                    srrLog("CRITTERS_BACK_NO_NAV", { parentId: String(parentId || ""), message: String(error && error.message ? error.message : error) });
                    return false;
                  }
                }
              };
            }
          }, HeaderCritters);
          srrLog("CRITTERS_REGISTERED", { slot: "conversation.session.header.actions", off: typeof regOff });
          return regOff;
        });
        return function () {
          if (typeof regOff === "function") { try { regOff(); } catch (_e) {} }
          if (typeof injectOff === "function") { try { injectOff(); } catch (_e) {} }
        };
      } catch (error) {
        console.error("[dsh-subagent-role-router] header critters failed to register (slots absent):", error);
        srrLog("CRITTERS_REGISTER_FAILED", { message: String(error && error.message ? error.message : error) });
        return function () { };
      }
    }

    apply.inject = inject;

    function apply(ctx, config) {
      // Capture the plugin context first: every helper that renders outside
      // apply reads services through it (see pluginCtx).
      pluginCtx = ctx;
      try {
        if (config && typeof config.showChatModelNotice === "boolean") {
          updateNoticeEnabled(config.showChatModelNotice);
        }
        if (config && typeof config.showHeaderCritters === "boolean") {
          updateCrittersEnabled(config.showHeaderCritters);
        }
      } catch (_e) {}

      ctx.effect(function () {
        return function () {
          updateNoticeEnabled(false);
        };
      }, "dsh-subagent-role-router: notice toggle lifecycle");
      // The old `connection.api.llm.models()` seat no longer exists. The current
      // model catalog lives on the `remote.session` namespaced service.
      //
      // `remote.session` is mounted ASYNCHRONOUSLY by `remote.$mount()`
      // (`packages/api/gateway/src/client/index.ts`: `remoteServiceKey(ns)` →
      // `remote.<ns>`, mounted from an async `$mount`). Reading it ONCE during
      // `apply` therefore usually captures `undefined` when the gateway has not
      // finished mounting yet — and because the value was captured, the catalog
      // stayed empty for the lifetime of the page. That is what left the
      // Provider/Model dropdowns permanently blank.
      //
      // Resolve it lazily on EVERY call instead, so a late mount is picked up.
      // `remote` is held as the lookup root rather than the leaf so the leaf is
      // re-read per call. The official sibling card declares
      // `inject: ['…','remote','remote.session',…]` to have Cordis wait for it;
      // we stay soft-injected (a missing gateway must not withhold the card)
      // and re-probe instead.
      var remoteRoot = typeof ctx.get === "function" ? ctx.get("remote") : undefined;

      // Bounded re-probe budget. Spaced in a browser so a late `remote.$mount()`
      // is picked up; `sleep` degrades to a no-op where `setTimeout` is absent
      // (the Node test sandbox), so the retry PATH stays covered without real
      // waiting.
      var CATALOG_RETRY_ATTEMPTS = 4;
      var CATALOG_RETRY_DELAY_MS = 250;
      var sleep = function (ms) {
        return new Promise(function (resolve) {
          if (typeof setTimeout !== "function") { resolve(); return; }
          setTimeout(resolve, ms);
        });
      };

      /** One probe. `null` means "not answerable yet" — the retryable case. */
      var loadCatalogOnce = function () {
        var sessionRemote = ctx.get ? ctx.get("remote.session") : undefined;
        if (!sessionRemote) sessionRemote = remoteRoot && remoteRoot.session;
        if (!sessionRemote || typeof sessionRemote.modelCatalog !== "function") return Promise.resolve(null);
        return sessionRemote.modelCatalog().then(function (response) {
          if (!response || !response.ok) return null;
          return (response.value && response.value.groups) || [];
        }).catch(function () { return null; });
      };

      /**
       * Load the model catalog, re-probing a BOUNDED number of times while the
       * answer is still empty.
       *
       * A single probe is not enough, and the failure it produces is not
       * cosmetic: `SubagentModelRow` reads this catalog to populate the
       * Provider/Model selects, and `addRoute()` seeds a new route from
       * `groups[0].id`. With an empty catalog `addRoute()` writes
       * `provider: ""`, so the Provider select offers ONLY the "inherit"
       * option, the Model select is disabled behind `!route.provider`, and
       * `hasIncompleteRoute` then keeps Save permanently disabled. The report
       * is "the model cannot be selected at all".
       *
       * The window is real: `remote.session` is mounted by an asynchronous
       * `remote.$mount()`, and this plugin deliberately soft-probes it (so a
       * host without the gateway still shows the card) instead of declaring
       * `inject: ['remote','remote.session']` the way the official
       * `ui-settings-subagent` card does. Declaring it is what makes the
       * official card wait; soft-probing without a re-probe just reports the
       * moment the probe happened. Re-probing closes that gap on both sides.
       *
       * Stops early on the first non-empty answer, so the common path is one
       * round trip; an empty catalog after the full budget is returned as-is
       * (a host that genuinely has no providers must not spin).
       */
      var loadCatalog = function () {
        var attempt = 0;
        var step = function () {
          return loadCatalogOnce().then(function (groups) {
            if (groups !== null && groups.length > 0) return groups;
            attempt = attempt + 1;
            if (attempt >= CATALOG_RETRY_ATTEMPTS) return groups === null ? [] : groups;
            return sleep(CATALOG_RETRY_DELAY_MS).then(step);
          });
        };
        return step();
      };

      // Register locale for this component.
      //
      // The host `locale` service THROWS when a namespace already holds a locale
      // (`dsh-client-locale`: `locale namespace "…" already has locale "…"`), and
      // Cordis keeps a fiber's registrations alive while `apply` re-runs for its
      // replacement. Registering unconditionally therefore makes the SECOND
      // apply() of this plugin throw at the top of the function — before either
      // card is registered — so the client half never activates and web boot
      // reports `dsh-subagent-role-router: failed`.
      //
      // `ctx.effect` ties the registration to the current fiber: Cordis disposes
      // it before running the replacement, so a re-apply starts from a clean
      // namespace. Same pattern as `dsh-ldvh`/`dsh-sub-cli`.
      ctx.effect(function () {
        var offZh = ctx.locale.register(SUBAGENT_ROW_LOCALE, "zh", SUBAGENT_ROW_ZH);
        var offEn = ctx.locale.register(SUBAGENT_ROW_LOCALE, "en", SUBAGENT_ROW_EN);
        return function () {
          if (typeof offZh === "function") offZh();
          if (typeof offEn === "function") offEn();
        };
      }, "dsh-subagent-role-router: settings copy");

      // ── trajectory: surface the subagent model per request ──────────────
      // agent-loop appends a `request/context` frame (provider/model) whenever
      // the provider or model changes — failover switches trigger it with zero
      // host changes. Register a trajectory definition that renders that frame
      // as a compact "Current provider/model" row inside the subagent's trajectory view.
      if (ctx.uiConversation && ctx.uiConversation.events && typeof ctx.uiConversation.events.register === "function") {
        var trajectoryT = ctx.locale.bind(SUBAGENT_ROW_LOCALE);
        var modelContextDefinition = {
          kind: "trajectory-subagent-model",
          target: "trajectory",
          match: function (event) {
            return event.type === "request/context" ? { id: String(event.seq), role: "start" } : null;
          },
          start: function (_context, match) {
            var event = match.event;
            var data = event.data || {};
            var label = trajectoryT("row.trajectoryModel") + "：" + (data.provider ? data.provider + (data.model ? "/" + data.model : "") : (data.model || ""));
            return {
              kind: "context",
              seq: event.seq,
              time: event.time,
              content: [{ type: "text", text: label }],
              source: { kind: "plugin:dsh-subagent-role-router", form: "notice" }
            };
          },
          update: function (context) { return context.state; },
          buildViewNode: function (context) {
            if (context.state === void 0) return null;
            return {
              key: context.key,
              kind: context.kind,
              id: context.id,
              target: "trajectory",
              anchorSeq: context.state.seq,
              location: context.start && context.start.location ? context.start.location : { kind: "unresolved" },
              data: { kind: "node", node: context.state }
            };
          }
        };
        // `ctx.effect` ties the registration to this fiber, so Cordis disposes it
        // before re-running `apply` for a replacement fiber. Registering BARE is
        // wrong here: `ConversationEventRegistry.register` throws
        // `conversation Definition "<kind>" is already registered` on a duplicate
        // kind, so the second apply would abort — taking the settings-card
        // registration below it down with it. Every official consumer wraps this
        // in `ctx.effect` (ui-plan, ui-deliverables, …).
        ctx.effect(function () {
          return ctx.uiConversation.events.register(modelContextDefinition);
        }, "dsh-subagent-role-router: trajectory model row");

        // ── chat: surface the subagent model in the conversation view ──
        // agent-loop writes a `request/header` frame with a `reason` the first
        // time the subagent builds a request ("initial"), on every provider /
        // model change ("change" — including failover switches), and when a
        // persisted session resumes ("resume"). The frame header carries the
        // full config (provider/model), so the conversation can show exactly
        // which route is in use — no host-side changes required.
        // 节点 kind 用**自有值**（`CHAT_MODEL_NODE_KIND`），不复用内置 `context`。
        // 旧注释曾写「复用内置注入行（ContextMessageNodeView）」——该复用目标在
        // 宿主 0.1.7 已不存在：`dsh-client-ui-chat` 的 `isVisibleChatNode()` 明确
        // 排除 `node.kind === "context"`（除非含 tool-addition/removal 块），故
        // 复用 `context` 的结果是**行永远不可见**。自有 kind 不在黑名单内，配一个
        // 自有渲染器即可见。trajectory 侧不受影响（该黑名单只在 ui-chat）。
        var chatT = ctx.locale.bind(SUBAGENT_ROW_LOCALE);
        var chatModelDefinition = {
          kind: "chat-subagent-model",
          target: "chat",
          match: function (event) {
            if (event.type !== "request/header") return null;
            if (!isNoticeEnabled()) return null;
            // DSH 0.1.2 also appends a "series" header when a follow-up
            // turn starts a new request series with an UNCHANGED config:
            // no route change to surface, and claiming it would add one
            // redundant "Current provider/model" row per turn.
            if ((event.data || {}).reason === "series") return null;
            return { id: String(event.seq), role: "start" };
          },
          start: function (_context, match) {
            var event = match.event;
            var data = event.data || {};
            var header = data.header || {};
            var config = header.config || {};
            var reason = data.reason === "change" ? "row.chatModelChange" : data.reason === "resume" ? "row.chatModelResume" : "row.chatModelInitial";
            var label = chatT(reason) + "：" + (config.provider ? config.provider + (config.model ? "/" + config.model : "") : (config.model || ""));
            return {
              kind: CHAT_MODEL_NODE_KIND,
              seq: event.seq,
              time: event.time,
              content: [{ type: "text", text: label }],
              // `summary` is the collapsed row's one-line account (notice form):
              // without it the row only shows the provenance label and hides the
              // model behind expansion.
              source: { kind: "plugin:dsh-subagent-role-router", form: "notice", summary: label },
              provenance: { role: "inject", label: "dsh-subagent-role-router" },
              form: "notice"
            };
          },
          update: function (context) { return context.state; },
          buildViewNode: function (context) {
            if (context.state === void 0) return null;
            return {
              key: context.key,
              kind: CHAT_MODEL_NODE_KIND,
              id: context.id,
              target: "chat",
              anchorSeq: context.state.seq,
              location: context.start && context.start.location ? context.start.location : { kind: "unresolved" },
              visibility: "visible",
              data: context.state
            };
          }
        };
        ctx.effect(function () {
          return ctx.uiConversation.events.register(chatModelDefinition);
        }, "dsh-subagent-role-router: chat model row");

        // 自有节点 kind 必须配自己的渲染器（宿主按 `entryKey = node.kind` 分派）。
        // 缺这一步，该行会落到 `ChatNodeSeat` 的 `fallback`（JsonBlock）——用户看到
        // 的不是「模型行」，而是一坨原始 JSON。
        ctx.effect(function () {
          return registerSubagentModelNotice(ctx);
        }, "dsh-subagent-role-router: chat notice row");
      }

      // ── live route picker in the subagent conversation header ────────────
      //
      // Registered unconditionally (NOT inside the `uiConversation` block above):
      // it needs only `slots` + the shared model catalog, so a host without the
      // conversation event registry must still get the picker. `ctx.effect` ties
      // the registration to this fiber so a hot reload replaces it cleanly.
      ctx.effect(function () {
        return registerLiveRoutePicker(ctx, loadCatalog);
      }, "dsh-subagent-role-router: live route picker");

      // 批量换模型入口：同一个 slot 体系，但是输入框左侧行（EGM 宠物那排），
      // order 5 让它排在需要空间的自定义入口左边。无条件注册：宿主没这个槽
      // 位时 register 会被 catch 住，不影响其它功能。
      ctx.effect(function () {
        return registerBatchSwitch(ctx);
      }, "dsh-subagent-role-router: batch switch entry");

      // Header critters ride the same slot system but a different surface:
      // the session header's utilities list. Registered unconditionally, like
      // the picker, so a host without the conversation registry still gets it.
      ctx.effect(function () {
        return registerHeaderCritters(ctx);
      }, "dsh-subagent-role-router: header critters");

      // ── selection shim: reroute subagent-targeted model picks ────────────
      // Installed unconditionally: it is data-path plumbing, not UI, and it
      // must survive hosts where the conversation registry is absent. It is
      // what makes a theme's own model seat work on a subagent page at all
      // (the host gates that seat on `available()`); the picker stays the one
      // visible control and suppresses the others via claimModelControl.
      ctx.effect(function () {
        var handle = installSelectionShim(ctx);
        return handle.dispose;
      }, "dsh-subagent-role-router: selection shim");

      // ── stop fallback: a child the host's interrupt lookup forgot ─────────
      // The host stop button can report success and leave the child running
      // (its interrupt returns silently on a resident-table miss). Patch the
      // shared cancel once, measure the result, and re-interrupt through this
      // plugin's endpoint when the child is still going. Retried on a timer
      // because no session exists yet when apply() runs.
      ctx.effect(function () {
        var timers = [];
        var attempt = function () { installStopFallback(); };
        attempt();
        var hasTimer = typeof setTimeout === "function";
        if (hasTimer) {
          for (var delay of [1500, 5000, 15000]) timers.push(setTimeout(attempt, delay));
        }
        return function () {
          if (hasTimer) {
            for (var timer of timers) clearTimeout(timer);
          }
          if (STOP_FALLBACK.restore) STOP_FALLBACK.restore();
        };
      }, "dsh-subagent-role-router: stop fallback");

      // The card's settings scope. The `configForms` block below assigns a
      // FORWARDING scope here: the reference stays stable while its target
      // controller re-binds underneath, so the card never needs re-registering
      // (see that block for why pinning one controller is the "card shows but
      // will not save" failure).
      //
      // `runtimeDiagnostics` is filled by the same block and surfaces the
      // live binding state inside the card, so a host whose mirror never
      // answers shows WHY instead of a silently grey Save button.
      var settingsScope = null;
      var runtimeDiagnostics = function () { return null; };
      var subagentRowInjected = function () {
        return {
          settingsScope: settingsScope,
          loadCatalog: loadCatalog,
          write: function (value) {
            return persistDefaultModels(settingsScope, value);
          },
          diagnostics: runtimeDiagnostics
        };
      };

      // `configForms` is the 0.1.7 client settings surface; soft-inject it so the
      // card simply stays absent when the service is unavailable, instead of
      // blocking the whole client plugin.
      //
      // The scope is a FORWARDING scope, following `dsh-connect-trae` — the local
      // sibling running against this same Desktop host. The describe mirror
      // answers ASYNCHRONOUSLY relative to `apply()`, and the Host may serve this
      // bundle under a name that does not exist yet at boot
      // (`include:dsh-subagent-role-router` is exactly such an entry). Binding
      // ONE controller and keeping it is the observed failure: the controller is
      // pinned to its namespace forever, so a card bound to the declared id
      // writes to a namespace the Host does not serve — every write is REFUSED
      // (`No configurable plugin entry "…"`) while the controls stay enabled,
      // because the mirror reports a global `writable` even for a missing
      // namespace. That is the "card appears but will not save" report.
      //
      // The scope therefore forwards every read/write to the CURRENT controller
      // and re-binds whenever the mirror changes; before the mirror lists the
      // namespace it reports `status: 'unavailable', writable: false`, so the card
      // is read-only rather than offering controls that cannot save.
      ctx.inject(["configForms"], function (formsCtx) {
        var forms = formsCtx.configForms;

        // Namespace the mirror ALREADY lists as served, or null while the mirror
        // has not answered yet. Only a namespace that really exists may be bound:
        // guessing is what produces the refused writes described above. The
        // probe also records EVERY candidate it saw, for the in-card diagnostics.
        var seenCandidates = [];
        var servedNamespaceNow = function () {
          seenCandidates = [];
          try {
            var view = forms.describe().getSnapshot().view;
            var namespaces = ((view && view.namespaces) || []).map(function (entry) {
              return entry && entry.ns;
            });
            for (var i = 0; i < namespaces.length; i++) {
              if (typeof namespaces[i] === "string" && /subagent-default-model/i.test(namespaces[i])) {
                seenCandidates.push(namespaces[i]);
              }
            }
            return namespaces.find(function (ns) {
              return ns === SUBAGENT_MODEL_SETTINGS_NS;
            }) ?? namespaces.find(function (ns) {
              return ns === "include:" + SUBAGENT_MODEL_SETTINGS_NS;
            }) ?? namespaces.find(function (ns) {
              return /subagent-default-model/i.test(ns || "");
            }) ?? null;
          } catch (_e) {
            return null;
          }
        };

        var lastBoundNamespace = null;
        var lastMirrorStatus = "unknown";
        var lastSeenViewNamespaces = 0;
        // The last SAVE this plugin completed, serialized. It lives HERE — on
        // the scope, i.e. for the plugin's lifetime — rather than in the card's
        // state, because the card is UNMOUNTED whenever the user switches away
        // from the Plugins page. A ref dies with the unmount, and the remounted
        // card re-seeds itself from whatever the mirror answers then — observed
        // live: the mirror can still serve the PREVIOUS document long after the
        // write verifiably landed, so the remounted card showed the route the
        // user had just deleted. Holding the save here lets the remounted card
        // seed from what was actually SAVED, and the convergence poll release
        // the hold once the mirror agrees.
        var lastSavedForm = null;
        settingsScope = (function () {
          var current;
          var currentOff;
          var mirrorOff = null;
          var timerId = null;
          var syncNotice = function () {
            try {
              if (current && typeof current.getSnapshot === "function") {
                var snap = current.getSnapshot();
                if (snap && snap.value && typeof snap.value.showChatModelNotice === "boolean") {
                  updateNoticeEnabled(snap.value.showChatModelNotice);
                }
                if (snap && snap.value && typeof snap.value.showHeaderCritters === "boolean") {
                  updateCrittersEnabled(snap.value.showHeaderCritters);
                }
              }
            } catch (_e) {}
          };
          // Bounded mirror (re)loads. ONE forced read is not enough: the mirror
          // reads through the ASYNCHRONOUS `remote.settings` namespace, so a read
          // issued before that mount settles comes back empty — and the store's
          // own `ensure()` only reads from `idle`, so it will not retry for us.
          // A one-shot attempt therefore leaves the scope unbound FOREVER: the
          // card still renders (it registers unconditionally), but every Save
          // reports that the Host serves no settings store. That is the reported
          // failure, and re-reading until the namespace appears is the fix.
          var MIRROR_LOAD_ATTEMPTS = 6;
          var MIRROR_LOAD_DELAY_MS = 300;
          var loadAttempts = 0;
          var listeners = new Set();
          var notify = function () {
            Array.from(listeners).forEach(function (listener) { listener(); });
          };
          var scope = {
            getSnapshot: function () {
              return current ? current.getSnapshot() : { status: "unavailable", value: void 0, writable: false };
            },
            subscribe: function (listener) {
              listeners.add(listener);
              return function () { listeners.delete(listener); };
            },
            set: function (field, value) {
              return current ? current.set(field, value) : Promise.resolve(false);
            },
            // One atomic mutation for a whole save, when the controller exposes
            // `mutate`. Six independent `set()` calls are six Host transactions,
            // each taking its own expectedRevision; a reload between them makes a
            // later field fail a revision check while the promise still resolves,
            // which the card then reports as `notApplied:ready:writable=true`.
            // `mutate(namespace, ops, revision)` is the controller's own
            // path-addressed, single-revision write, so the save either lands
            // entirely or refuses once. Returns whether the Host accepted it,
            // matching the `set()` contract; `undefined` means this controller
            // has no atomic form and the caller must fall back.
            setMany: function (pairs) {
              if (!current || typeof current.mutate !== "function") return Promise.resolve(void 0);
              var ops = pairs.map(function (pair) {
                return { op: "set", path: [pair[0]], value: pair[1] };
              });
              return Promise.resolve(current.mutate(ops));
            },
            // Force one mirror re-read, then re-derive the bound controller.
            //
            // A write needs this: `configEditor.edit()` persists the profile
            // patch and the Loader RE-CREATES the entry's fiber, so between the
            // write answering and the mirror seeing the new document there is a
            // window where a read-back still returns the PREVIOUS value. The
            // card's Save verification reads exactly that snapshot, so without
            // a forced re-read a landed write is reported as
            // `notApplied:ready:writable=true` — accepted by the Host, invisible
            // to the client. `derive()` cannot cover it either: it is driven by
            // mirror CHANGES, and a reload that changes nothing observable emits
            // none.
            //
            // The bounded attempt counter is deliberately NOT consulted here:
            // this is an explicit, caller-driven refresh (one per read-back
            // attempt), not a boot-time retry loop.
            refresh: function () {
              var loaded;
              try {
                var mirror = forms.describe();
                loaded = mirror && typeof mirror.load === "function" ? Promise.resolve(mirror.load()) : Promise.resolve();
              } catch (_e) {
                loaded = Promise.resolve();
              }
              return loaded.catch(function () { /* re-derive below regardless */ }).then(function () {
                rebind();
              });
            },
            // The last completed save, held for the plugin's LIFETIME (not the
            // card's mount). The card reads it on remount to seed its form from
            // what was actually saved — rather than from a mirror that may still
            // answer the previous document — and clears it once the mirror
            // agrees. See `lastSavedForm` above for why it lives here.
            savedForm: function () {
              return lastSavedForm;
            },
            clearSavedForm: function () {
              lastSavedForm = null;
            },
            setSavedForm: function (form) {
              lastSavedForm = form;
            }
          };
          // Force one mirror read, then arrange the next bounded attempt. The
          // read's own store update usually triggers `rebind` through the mirror
          // subscription; the timer only covers the case where it does not.
          var scheduleMirrorLoad = function () {
            if (loadAttempts >= MIRROR_LOAD_ATTEMPTS) return;
            loadAttempts = loadAttempts + 1;
            var loaded;
            try {
              var mirror = forms.describe();
              if (!mirror || typeof mirror.load !== "function") return;
              loaded = Promise.resolve(mirror.load());
            } catch (_e) {
              loaded = Promise.resolve();
            }
            loaded.catch(function () { /* attempt below still runs */ }).then(function () {
              if (current !== void 0) return;
              if (loadAttempts >= MIRROR_LOAD_ATTEMPTS) return;
              if (typeof setTimeout !== "function") { rebind(); return; }
              if (timerId !== null) clearTimeout(timerId);
              timerId = setTimeout(function () {
                timerId = null;
                rebind();
              }, MIRROR_LOAD_DELAY_MS);
            });
          };
          var rebind = function () {
            try {
              var snapshot = forms.describe().getSnapshot();
              lastMirrorStatus = snapshot.status;
              lastSeenViewNamespaces = ((snapshot.view && snapshot.view.namespaces) || []).length;
            } catch (_e) { /* diagnostics only */ }
            var namespace = servedNamespaceNow();
            lastBoundNamespace = namespace;
            var next = namespace === null ? void 0 : forms.get(namespace);
            if (next !== current) {
              if (typeof currentOff === "function") currentOff();
              current = next;
              currentOff = current && typeof current.subscribe === "function" ? current.subscribe(function () {
                syncNotice();
                notify();
              }) : void 0;
              syncNotice();
              notify();
            }
            // Still unbound: the mirror has not listed the namespace yet, so ask
            // it again (bounded) rather than latching read-only for the session.
            if (next === void 0) scheduleMirrorLoad();
          };
          rebind();
          try {
            var describe = forms.describe();
            if (describe && typeof describe.subscribe === "function") {
              mirrorOff = describe.subscribe(rebind);
            }
          } catch (_e) { /* no mirror surface: the card stays read-only */ }

          scope.dispose = function () {
            if (timerId !== null) {
              clearTimeout(timerId);
              timerId = null;
            }
            if (typeof mirrorOff === "function") {
              try { mirrorOff(); } catch (_e) {}
              mirrorOff = null;
            }
            if (typeof currentOff === "function") {
              try { currentOff(); } catch (_e) {}
              currentOff = null;
            }
            listeners.clear();
          };
          return scope;
        })();

        // One-shot runtime diagnostics for the card: the exact facts a grey Save
        // button hides — did the mirror answer, what namespaces does it list for
        // this plugin, and which one got bound. The revision rides along because
        // a save that fails at a constant revision never reached the Host at
        // all, while one that fails across RISING revisions is being refused on
        // the fence — the single most useful number when triaging a save.
        runtimeDiagnostics = function () {
          var snap = settingsScope ? settingsScope.getSnapshot() : void 0;
          return {
            mirrorStatus: lastMirrorStatus,
            viewNamespaces: lastSeenViewNamespaces,
            candidates: seenCandidates,
            bound: lastBoundNamespace,
            scopeStatus: snap ? snap.status : "unavailable",
            writable: snap ? snap.writable === true : false,
            revision: snap && snap.revision !== void 0 ? snap.revision : null
          };
        };

        // Cards register ONCE, unconditionally, exactly like the local siblings
        // (`dsh-connect-workbuddy` / `dsh-connect-trae`). They deliberately do NOT
        // follow the namespace: the forwarding scope above re-routes itself, so a
        // late mirror answer cannot leave a card pinned to a namespace the Host
        // does not serve, and the card needs no re-registration to recover.
        var registerAllCards = function () {
          var unregisters = [];
          var regSlot = function (slotName, key) {
            try {
              var regOff = null;
              var injectOff = ctx.slots.inject(slotName, function () {
                regOff = ctx.slots.register({
                  name: slotName,
                  key: key,
                  priority: 30,
                  locale: SUBAGENT_ROW_LOCALE,
                  inject: subagentRowInjected
                }, SubagentModelCard);
                return regOff;
              });
              unregisters.push(function () {
                if (typeof regOff === "function") {
                  try { regOff(); } catch (_e) {}
                }
                if (typeof injectOff === "function") {
                  try { injectOff(); } catch (_e) {}
                }
              });
            } catch (error) {
              console.error('[dsh-subagent-role-router] settings card slot "' + slotName + '" failed to register (host provider unaffected):', error);
            }
          };
          regSlot("plugins.bundle.config", "dsh-subagent-role-router");
          regSlot("plugins.row.config", "dsh-subagent-role-router#dsh-subagent-role-router");
          try {
            var itemRegOff = null;
            var itemInjectOff = ctx.slots.inject("plugins.item", function () {
              itemRegOff = ctx.slots.register({
                name: "plugins.item",
                id: "subagent-role-router",
                order: 35,
                label: function () { return "子代理路由与故障转移"; },
                locale: SUBAGENT_ROW_LOCALE,
                inject: subagentRowInjected
              }, SubagentModelCard);
              return itemRegOff;
            });
            unregisters.push(function () {
              if (typeof itemRegOff === "function") {
                try { itemRegOff(); } catch (_e) {}
              }
              if (typeof itemInjectOff === "function") {
                try { itemInjectOff(); } catch (_e) {}
              }
            });
          } catch(e) { console.error(e); }

          return function () {
            unregisters.forEach(function (off) {
              try { off(); } catch (_e) {}
            });
          };
        };

        var effectTarget = (formsCtx && typeof formsCtx.effect === "function") ? formsCtx : ctx;
        if (effectTarget && typeof effectTarget.effect === "function") {
          effectTarget.effect(function () {
            return function () {
              if (settingsScope && typeof settingsScope.dispose === "function") {
                settingsScope.dispose();
              }
            };
          }, "dsh-subagent-role-router: settingsScope lifecycle");

          effectTarget.effect(registerAllCards, "dsh-subagent-role-router: settings card registration");
        } else {
          registerAllCards();
        }
      });
    }

    // `checkEffortSupport` is exported as a pure test seam (same convention as
    // the host half's `settingsSectionInstaller`); the module loader only reads
    // `apply` / `inject`.
    return {
      apply: apply,
      inject: inject,
      checkEffortSupport: checkEffortSupport,
      normalizeForkWindowTurns: normalizeForkWindowTurns,
      isNoticeEnabled: isNoticeEnabled,
      updateNoticeEnabled: updateNoticeEnabled,
      serializeDefaultModels: serializeDefaultModels,
      // Role candidate pools: the pure form/parse helpers are exported for the
      // same reason as `checkEffortSupport` — they carry the invariants that are
      // expensive to verify through the rendered card.
      normalizeRoleRoutes: normalizeRoleRoutes,
      serializeRolePool: serializeRolePool,
      roleRouteIncomplete: roleRouteIncomplete,
      normalizeRoleCooldownSeconds: normalizeRoleCooldownSeconds,
      // Plugin exemption rules: same pure-helper convention as the role pool.
      SubagentModelRow: SubagentModelRow,
      normalizeExemptRules: normalizeExemptRules,
      serializeExemptRules: serializeExemptRules,
      exemptRuleIncomplete: exemptRuleIncomplete,
      savedFormFingerprint: savedFormFingerprint,
      seedFromSavedForm: seedFromSavedForm,
      normalizeDefaultModels: normalizeDefaultModels,
      effortChoicesFor: effortChoicesFor,
      // Selection shim: exported so the patch/restore contract and the
      // subagent-vs-parent routing decision are testable without a browser.
      installSelectionShim: installSelectionShim,
      claimModelControl: claimModelControl,
        installStopFallback: installStopFallback,
      hostSaysSubagent: hostSaysSubagent,
      resolveCurrentSessionId: resolveCurrentSessionId,
      // Recorded picks: children have no projection of their own, so the pick
      // has to outlive any single directory instance. Pure enough to test.
      rememberPicked: rememberPicked,
      pickedFor: pickedFor,
      forgetPicked: forgetPicked,
      composerCensus: composerCensus,
      // Batch switch: the payload/geometry decisions are pure, so they are
      // exported and pinned by tests instead of verified by clicking a card.
      batchText: batchText,
      batchModelKey: batchModelKey,
      batchSplitModelKey: batchSplitModelKey,
      batchRequestStale: batchRequestStale,
      batchPresence: batchPresence,
      batchTargets: batchTargets,
      batchEffortPlan: batchEffortPlan,
      batchSelectionsFrom: batchSelectionsFrom,
      batchResultSummary: batchResultSummary,
      batchBoxFor: batchBoxFor,
      // Six critter characters: the species pick is a pure hash decision, so it
      // is pinned by tests the same way the batch payload is.
      pickCritterKind: pickCritterKind,
      critterArt: critterArt,
      // Panel rows print a preset phrase instead of the raw host label; the
      // pick is a pure function of childId, so a test can pin its stability.
      critterPhrase: critterPhrase,
      critterPhrases: CRITTER_PHRASES.slice(),
      // Short display title for the critter tag and the panel's first column;
      // hover windows are exported so tests can drive the intent timers.
      critterShortTitle: critterShortTitle,
      critterTitleMax: CRITTER_TITLE_MAX,
      critterHoverOpenMs: CRITTERS_HOVER_OPEN_MS,
      critterHoverCloseMs: CRITTERS_HOVER_CLOSE_MS,
      critterTokenTotal: critterTokenTotal,
      formatCritterTokens: formatCritterTokens,
      formatCritterDuration: formatCritterDuration,
      // Store-driven seams: row derivation and the presence signature are the
      // two pure functions the no-poll design leans on, so tests pin them.
      critterRowsEqual: critterRowsEqual,
      routePollSignature: routePollSignature,
      // Event-driven verification seams (no-poll): store folding, epoch
      // tracking and the SSE page-singleton are pure enough to pin in tests.
      liveStoreSignature: liveStoreSignature,
      canonicalSseChildId: canonicalSseChildId,
      noteRouteEpoch: noteRouteEpoch,
      liveRouteEventsSubscribe: liveRouteEventsSubscribe,
      deriveCritterRows: deriveCritterRows,
      // The family anchor (a child page shows its parent's children) is the
      // other pure seam the store-driven rows lean on.
      crittersAnchorOf: crittersAnchorOf,
      // The narrow subscription selector and the panel's metric reader: both
      // pure, both pinned by tests so the "render only on membership change"
      // contract cannot silently widen back to the whole table.
      crittersMembersKey: crittersMembersKey,
      deriveCritterMetrics: deriveCritterMetrics,
      batchCatalogSignature: batchCatalogSignature,
      srrDebugEnabled: srrDebugEnabled,
      critterKindsOf: function () {
        var out = [];
        for (var id in critterKinds) out.push({ childId: id, kind: critterKinds[id] });
        return out;
      },
      BatchSwitchEntry: BatchSwitchEntry,
      setPluginCtx: function (next) { pluginCtx = next; }
    };
  }
});
