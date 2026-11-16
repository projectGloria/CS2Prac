using System.Net;
using CounterStrikeSharp.API;
using CounterStrikeSharp.API.Core;

namespace PracSkins;

/// <summary>One line of a menu page.</summary>
public record MenuItem(string Label, Action<CCSPlayerController>? OnSelect = null, bool Current = false, string? Color = null);

/// <summary>A menu page. Items are built lazily and rebuilt when the player comes back to the page.</summary>
public class MenuPage
{
    public required string Title { get; init; }
    public required Func<List<MenuItem>> Build { get; init; }
    public List<MenuItem> Items { get; private set; } = new();
    public int Cursor { get; set; }

    public void Refresh(bool keepCursor = true)
    {
        Items = Build();
        if (!keepCursor)
        {
            var current = Items.FindIndex(i => i.Current);
            Cursor = current >= 0 ? current : 0;
        }
        Cursor = Items.Count == 0 ? 0 : Math.Clamp(Cursor, 0, Items.Count - 1);
    }
}

/// <summary>An open menu for one player.</summary>
public class MenuSession
{
    public Stack<MenuPage> Pages { get; } = new();
    public ulong LastButtons { get; set; }
    public ulong HeldButton { get; set; }
    public float HeldSince { get; set; }
    public float NextRepeat { get; set; }
    public float NextRender { get; set; }
    public string LastHtml { get; set; } = "";
    public MoveType_t PreviousMoveType { get; set; } = MoveType_t.MOVETYPE_WALK;
    public string? Flash { get; set; }
    public float FlashUntil { get; set; }
}

/// <summary>
/// A center-screen menu driven by movement keys: W/S move, A/D page, E select, R back. The player is frozen while
/// it is open, so the keys don't walk them around. Opened with css_menu (bind a key to it).
/// </summary>
public partial class PracSkins
{
    private const int VisibleItems = 7;
    private readonly Dictionary<int, MenuSession> _menus = new();

    private static readonly ulong BtnForward = (ulong)PlayerButtons.Forward;
    private static readonly ulong BtnBack = (ulong)PlayerButtons.Back;
    private static readonly ulong BtnLeft = (ulong)PlayerButtons.Moveleft;
    private static readonly ulong BtnRight = (ulong)PlayerButtons.Moveright;
    private static readonly ulong BtnUse = (ulong)PlayerButtons.Use;
    private static readonly ulong BtnReload = (ulong)PlayerButtons.Reload;
    private static readonly ulong RepeatButtons = BtnForward | BtnBack | BtnLeft | BtnRight;

    private bool MenuOpen(CCSPlayerController player) => _menus.ContainsKey(player.Slot);

    private void OpenMenu(CCSPlayerController player, MenuPage page)
    {
        if (!_menus.TryGetValue(player.Slot, out var session))
        {
            session = new MenuSession { LastButtons = (ulong)player.Buttons };
            _menus[player.Slot] = session;
            Freeze(player, session);
        }
        session.Pages.Clear();
        PushPage(player, page);
    }

    private void PushPage(CCSPlayerController player, MenuPage page)
    {
        if (!_menus.TryGetValue(player.Slot, out var session)) return;
        page.Refresh(keepCursor: false);
        session.Pages.Push(page);
        session.NextRender = 0;
    }

    /// <summary>Goes back one page; closes the menu from the first page.</summary>
    private void PopPage(CCSPlayerController player, int count = 1)
    {
        if (!_menus.TryGetValue(player.Slot, out var session)) return;
        for (var i = 0; i < count && session.Pages.Count > 0; i++) session.Pages.Pop();
        if (session.Pages.Count == 0)
        {
            CloseMenu(player);
            return;
        }
        session.Pages.Peek().Refresh();
        session.NextRender = 0;
    }

    private void CloseMenu(CCSPlayerController player)
    {
        if (!_menus.Remove(player.Slot, out var session)) return;
        Unfreeze(player, session);
        if (player.IsValid) player.PrintToCenterHtml(" ", 1);
    }

    /// <summary>Shows a short confirmation line under the menu.</summary>
    private void Flash(CCSPlayerController player, string text)
    {
        if (!_menus.TryGetValue(player.Slot, out var session)) return;
        session.Flash = text;
        session.FlashUntil = Server.CurrentTime + 2.5f;
        session.NextRender = 0;
    }

    private static void Freeze(CCSPlayerController player, MenuSession session)
    {
        var pawn = player.PlayerPawn.Value;
        if (pawn is not { IsValid: true }) return;
        session.PreviousMoveType = pawn.MoveType;
        SetMoveType(pawn, MoveType_t.MOVETYPE_NONE);
    }

    private static void Unfreeze(CCSPlayerController player, MenuSession session)
    {
        var pawn = player.IsValid ? player.PlayerPawn.Value : null;
        if (pawn is not { IsValid: true }) return;
        var restore = session.PreviousMoveType == MoveType_t.MOVETYPE_NONE ? MoveType_t.MOVETYPE_WALK : session.PreviousMoveType;
        SetMoveType(pawn, restore);
    }

    private static void SetMoveType(CCSPlayerPawn pawn, MoveType_t type)
    {
        pawn.MoveType = type;
        pawn.ActualMoveType = type;
        Utilities.SetStateChanged(pawn, "CBaseEntity", "m_MoveType");
    }

    private void OnMenuTick()
    {
        if (_menus.Count == 0) return;
        var now = Server.CurrentTime;
        foreach (var (slot, session) in _menus.ToList())
        {
            var player = Utilities.GetPlayerFromSlot(slot);
            if (player is not { IsValid: true } || player.IsBot || session.Pages.Count == 0)
            {
                _menus.Remove(slot);
                continue;
            }

            var buttons = (ulong)player.Buttons;
            var pressed = buttons & ~session.LastButtons;
            session.LastButtons = buttons;

            // holding W/S/A/D repeats after a short delay, for long lists
            var held = buttons & RepeatButtons;
            if ((pressed & RepeatButtons) != 0)
            {
                session.HeldButton = pressed & RepeatButtons;
                session.HeldSince = now;
                session.NextRepeat = now + 0.35f;
            }
            else if (held != 0 && (held & session.HeldButton) != 0 && now >= session.NextRepeat)
            {
                pressed |= session.HeldButton;
                session.NextRepeat = now + 0.06f;
            }

            if (pressed != 0) HandleMenuInput(player, session, pressed);
            if (!_menus.ContainsKey(slot)) continue; // closed by the input

            if (now >= session.NextRender) RenderMenu(player, session, now);
            // CS2 keeps a center HTML message up for only a moment whatever duration is asked for, so it is re-sent
            // every tick (as CS2 menu plugins do); once a second made the menu blink on and off.
            player.PrintToCenterHtml(session.LastHtml, 1);
        }
    }

    private void HandleMenuInput(CCSPlayerController player, MenuSession session, ulong pressed)
    {
        var page = session.Pages.Peek();
        var n = page.Items.Count;
        var before = page.Cursor;
        if (n > 0)
        {
            if ((pressed & BtnForward) != 0) page.Cursor = (page.Cursor - 1 + n) % n;
            if ((pressed & BtnBack) != 0) page.Cursor = (page.Cursor + 1) % n;
            if ((pressed & BtnLeft) != 0) page.Cursor = Math.Max(0, page.Cursor - VisibleItems);
            if ((pressed & BtnRight) != 0) page.Cursor = Math.Min(n - 1, page.Cursor + VisibleItems);
        }
        if (page.Cursor != before) session.NextRender = 0;

        if ((pressed & BtnReload) != 0)
        {
            PopPage(player);
            return;
        }
        if ((pressed & BtnUse) != 0 && n > 0)
        {
            var item = page.Items[page.Cursor];
            try
            {
                item.OnSelect?.Invoke(player);
            }
            catch (Exception e)
            {
                Logger.LogWarningSafe($"menu action '{item.Label}': {e}");
                Flash(player, "Something went wrong, see the server log");
            }
            if (_menus.TryGetValue(player.Slot, out var s) && s.Pages.Count > 0 && ReferenceEquals(s.Pages.Peek(), page))
            {
                page.Refresh();
                s.NextRender = 0;
            }
        }
    }

    private static string Esc(string s) => WebUtility.HtmlEncode(s);

    private static string Trim(string s, int max = 42) => s.Length <= max ? s : s[..(max - 1)] + "…";

    private void RenderMenu(CCSPlayerController player, MenuSession session, float now)
    {
        var page = session.Pages.Peek();
        var html = new System.Text.StringBuilder();
        var crumbs = string.Join(" › ", session.Pages.Reverse().Select(p => p.Title));
        html.Append($"<font color='#e8a33d'>{Esc(Trim(crumbs, 60))}</font>");
        if (page.Items.Count > VisibleItems) html.Append($" <font color='#8a93a3'>{page.Cursor + 1}/{page.Items.Count}</font>");
        html.Append("<br>");

        if (page.Items.Count == 0) html.Append("<font color='#8a93a3'>(nothing here)</font><br>");
        var start = Math.Clamp(page.Cursor - VisibleItems / 2, 0, Math.Max(0, page.Items.Count - VisibleItems));
        for (var i = start; i < Math.Min(page.Items.Count, start + VisibleItems); i++)
        {
            var item = page.Items[i];
            var label = Esc(Trim(item.Label)) + (item.Current ? " ✔" : "");
            if (i == page.Cursor) html.Append($"<font color='#ffffff'>▶ {label}</font><br>");
            else html.Append($"<font color='{item.Color ?? "#b8bfcc"}'>&nbsp;&nbsp;{label}</font><br>");
        }

        if (session.Flash != null && now < session.FlashUntil) html.Append($"<font color='#4fbf7a'>{Esc(session.Flash)}</font><br>");
        html.Append("<font class='fontSize-s' color='#8a93a3'>W/S move · A/D page · E select · R back</font>");

        // Rebuilt on changes and once a second (so a flash line expires); OnMenuTick sends it every tick.
        session.LastHtml = html.ToString();
        session.NextRender = now + 1.0f;
    }
}

internal static class LoggerExtensions
{
    public static void LogWarningSafe(this Microsoft.Extensions.Logging.ILogger logger, string message) =>
        Microsoft.Extensions.Logging.LoggerExtensions.LogWarning(logger, "{Message}", message);
}
