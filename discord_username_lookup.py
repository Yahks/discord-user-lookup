import argparse
import base64
import csv
import json
import os
import time
from datetime import datetime, timezone
from http.cookiejar import Cookie
from typing import Any, Dict, List, Optional, Union

import requests

DISCORD_EPOCH_MS = 1420070400000


class DiscordUsernameLookup:
    """
    Standalone Discord login, session persistence, username-to-ID resolution,
    and profile lookup tool using captured Discord API v9 endpoints.
    """

    def __init__(
        self,
        token: Optional[str] = None,
        email: Optional[str] = None,
        password: Optional[str] = None,
        cookies: Optional[Union[Dict[str, str], str]] = None,
        installation_id: Optional[str] = None,
        account_file: str = "account.json",
        account_index: int = 0,
    ):
        self.token = (token or "").strip()
        self.email = (email or "").strip()
        self.password = password or ""
        self.account_file = account_file
        self.account_index = account_index
        self.base_url = "https://discord.com/api/v9"
        self.user_agent = (
            "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
            "(KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36"
        )

        self.headers: Dict[str, str] = {
            "Content-Type": "application/json",
            "Accept": "*/*",
            "Accept-Language": "en-NG,en-US;q=0.9,en;q=0.8",
            "Cache-Control": "no-cache",
            "Pragma": "no-cache",
            "Origin": "https://discord.com",
            "Referer": "https://discord.com/channels/@me",
            "Sec-Ch-Ua": '"Google Chrome";v="147", "Not.A/Brand";v="8", "Chromium";v="147"',
            "Sec-Ch-Ua-Mobile": "?0",
            "Sec-Ch-Ua-Platform": '"Linux"',
            "Sec-Fetch-Dest": "empty",
            "Sec-Fetch-Mode": "cors",
            "Sec-Fetch-Site": "same-origin",
            "User-Agent": self.user_agent,
            "X-Debug-Options": "bugReporterEnabled",
            "X-Discord-Locale": "en-US",
            "X-Discord-Timezone": "America/New_York",
            "X-Super-Properties": self._build_super_properties(),
        }

        if self.token:
            self.headers["Authorization"] = self.token
        if installation_id:
            self.headers["X-Installation-Id"] = installation_id

        self.session = requests.Session()
        self.session.headers.update(self.headers)
        self._load_cookies(cookies)

    def _load_cookies(self, cookies: Optional[Union[Dict[str, str], str]]) -> None:
        """Load persisted cookies (dict or raw Cookie header string) into session."""
        if not cookies:
            return

        cookie_dict: Dict[str, str] = {}
        if isinstance(cookies, dict):
            cookie_dict = {str(k): str(v) for k, v in cookies.items() if v is not None}
        elif isinstance(cookies, str):
            for part in cookies.split(";"):
                if "=" in part:
                    k, v = part.split("=", 1)
                    cookie_dict[k.strip()] = v.strip()

        for name, value in cookie_dict.items():
            c = Cookie(
                version=0,
                name=name,
                value=value,
                port=None,
                port_specified=False,
                domain=".discord.com",
                domain_specified=True,
                domain_initial_dot=True,
                path="/",
                path_specified=True,
                secure=True,
                expires=None,
                discard=True,
                comment=None,
                comment_url=None,
                rest={},
            )
            self.session.cookies.set_cookie(c)

    def _build_super_properties(self) -> str:
        """Build Base64-encoded X-Super-Properties matching the web client."""
        props = {
            "os": "Linux",
            "browser": "Chrome",
            "device": "",
            "device_model_name": "",
            "system_locale": "en-NG",
            "has_client_mods": False,
            "browser_user_agent": self.user_agent,
            "browser_version": "147.0.0.0",
            "os_version": "",
            "referrer": "",
            "referring_domain": "",
            "referrer_current": "",
            "referring_domain_current": "",
            "release_channel": "stable",
            "client_build_number": 673919,
            "client_event_source": None,
            "client_app_state": "focused",
        }
        raw = json.dumps(props, separators=(",", ":")).encode("utf-8")
        return base64.b64encode(raw).decode("utf-8")

    @staticmethod
    def _build_context_properties(location: str = "Quickswitcher") -> str:
        """Build Base64-encoded X-Context-Properties header."""
        raw = json.dumps({"location": location}, separators=(",", ":")).encode("utf-8")
        return base64.b64encode(raw).decode("utf-8")

    @staticmethod
    def snowflake_to_iso(snowflake_id: str) -> str:
        """Convert a Discord Snowflake ID into an ISO-8601 UTC creation timestamp."""
        try:
            ts_ms = (int(snowflake_id) >> 22) + DISCORD_EPOCH_MS
            return datetime.fromtimestamp(ts_ms / 1000.0, tz=timezone.utc).isoformat()
        except (ValueError, TypeError, OverflowError):
            return ""

    @staticmethod
    def build_avatar_url(
        user_id: str,
        avatar_hash: Optional[str],
        discriminator: str = "0",
    ) -> str:
        """Construct the CDN URL for a user's avatar (or default avatar)."""
        if avatar_hash:
            ext = "gif" if avatar_hash.startswith("a_") else "webp"
            return f"https://cdn.discordapp.com/avatars/{user_id}/{avatar_hash}.{ext}?size=256"
        try:
            if discriminator and discriminator != "0":
                index = int(discriminator) % 5
            else:
                index = (int(user_id) >> 22) % 6
        except (ValueError, TypeError):
            index = 0
        return f"https://cdn.discordapp.com/embed/avatars/{index}.png"

    def _request(self, method: str, endpoint: str, **kwargs) -> Optional[requests.Response]:
        """Internal helper with automatic backoff for 429 rate limits and 5xx errors."""
        url = f"{self.base_url}/{endpoint.lstrip('/')}"
        max_retries = 5

        for attempt in range(max_retries):
            try:
                response = self.session.request(method, url, timeout=20, **kwargs)

                if response.status_code == 429:
                    try:
                        retry_after = float(response.json().get("retry_after", 5))
                    except Exception:
                        retry_after = float(response.headers.get("Retry-After", 5))

                    print(f"   ⏳ Rate limited (429). Sleeping {retry_after + 0.2:.2f}s...")
                    time.sleep(retry_after + 0.2)
                    continue

                if response.status_code >= 500:
                    time.sleep(1.5 * (attempt + 1))
                    continue

                return response
            except requests.RequestException as exc:
                print(f"   ⚠️ Request exception: {exc}")
                time.sleep(2)

        return None

    def persist_session(self, user_meta: Optional[Dict[str, Any]] = None) -> None:
        """
        Persist the active auth token and session cookies back to account.json
        so subsequent runs reuse the authenticated session without re-logging in.
        """
        if not self.account_file or not os.path.exists(self.account_file):
            return

        try:
            with open(self.account_file, "r", encoding="utf-8") as f:
                accounts = json.load(f)
        except Exception as exc:
            print(f"   ⚠️ Could not read {self.account_file} to persist session: {exc}")
            return

        is_single = isinstance(accounts, dict)
        records = [accounts] if is_single else accounts
        if not isinstance(records, list) or self.account_index >= len(records):
            return

        entry = records[self.account_index]
        if self.token:
            entry["token"] = self.token

        cookie_jar = self.session.cookies.get_dict()
        if cookie_jar:
            existing_cookies = entry.get("cookies") if isinstance(entry.get("cookies"), dict) else {}
            entry["cookies"] = {**existing_cookies, **cookie_jar}

        if user_meta:
            entry["user_id"] = user_meta.get("id", entry.get("user_id", ""))
            entry["username"] = user_meta.get("username", entry.get("username", ""))
        entry["last_login_at"] = datetime.now(timezone.utc).isoformat()

        payload = records[0] if is_single else records
        try:
            with open(self.account_file, "w", encoding="utf-8") as f:
                json.dump(payload, f, indent=2)
            print(f"   💾 Persisted token & {len(entry.get('cookies', {}))} cookies to {self.account_file}")
        except Exception as exc:
            print(f"   ⚠️ Failed saving session to {self.account_file}: {exc}")

    def login_with_credentials(self) -> bool:
        """
        Authenticate via POST /api/v9/auth/login using email/username and password
        from account.json, handling MFA if prompted, then persist token & cookies.
        """
        if not self.email or not self.password:
            print("❌ Cannot perform credential login: missing email/username or password in account.json.")
            return False

        # Warm up session cookies by hitting discord.com/login first
        try:
            self.session.get("https://discord.com/login", timeout=15)
        except requests.RequestException:
            pass

        payload = {
            "login": self.email,
            "password": self.password,
            "undelete": False,
            "login_source": None,
            "gift_code_sku_id": None,
        }
        headers = {
            "Referer": "https://discord.com/login",
            "X-Context-Properties": self._build_context_properties("Login"),
        }
        # Ensure no stale Authorization header is sent during login
        self.session.headers.pop("Authorization", None)
        resp = self._request("POST", "auth/login", json=payload, headers=headers)

        if not resp:
            print("❌ Login request failed (no response).")
            return False

        try:
            data = resp.json()
        except Exception:
            print(f"❌ Login failed (HTTP {resp.status_code}): {resp.text[:200]}")
            return False

        if resp.status_code == 200 and data.get("token"):
            self.token = data["token"]
            self.session.headers["Authorization"] = self.token
            print("✅ Login successful!")
            user_meta = self.verify_token(persist=False)
            self.persist_session(user_meta)
            return True

        if resp.status_code == 200 and data.get("mfa") and data.get("ticket"):
            code = input("🔐 2FA/MFA code required. Enter 6-digit TOTP code: ").strip()
            if not code:
                print("❌ MFA cancelled.")
                return False
            mfa_resp = self._request(
                "POST",
                "auth/mfa/totp",
                json={"code": code, "ticket": data["ticket"], "login_source": None, "gift_code_sku_id": None},
                headers=headers,
            )
            if mfa_resp and mfa_resp.status_code == 200 and mfa_resp.json().get("token"):
                self.token = mfa_resp.json()["token"]
                self.session.headers["Authorization"] = self.token
                print("✅ MFA login successful!")
                user_meta = self.verify_token(persist=False)
                self.persist_session(user_meta)
                return True
            print("❌ MFA verification failed.")
            return False

        if data.get("captcha_key"):
            print("❌ Discord requested a CAPTCHA challenge for password login.")
            print("   Tip: Log in via browser once and paste the session token/cookies into account.json.")
            return False

        msg = data.get("message") or json.dumps(data)[:250]
        print(f"❌ Login failed (HTTP {resp.status_code}): {msg}")
        return False

    def verify_token(self, persist: bool = True) -> Optional[Dict[str, Any]]:
        """Verify token via GET /users/@me and optionally persist refreshed cookies."""
        if not self.token:
            return None

        self.session.headers["Authorization"] = self.token
        resp = self._request("GET", "users/@me")
        if resp and resp.status_code == 200:
            user_data = resp.json()
            disc = user_data.get("discriminator")
            discrim = f"#{disc}" if disc and disc != "0" else ""
            print(f"✅ Logged in as: {user_data.get('username')}{discrim} ({user_data.get('id')})")
            if persist:
                self.persist_session(user_data)
            return user_data

        status = resp.status_code if resp else "Connection Failed"
        print(f"⚠️ Token verification failed (HTTP {status}).")
        return None

    def ensure_authenticated(self) -> bool:
        """Verify existing token first; fall back to credential login if invalid/missing."""
        if self.token and self.verify_token(persist=True):
            return True

        if self.email and self.password:
            print("🔑 Attempting credential login using account.json...")
            return self.login_with_credentials()

        print("❌ No valid token and no email/password credentials available in account.json.")
        return False

    def get_channel_info(self, channel_id: str) -> Optional[Dict[str, Any]]:
        """GET /api/v9/channels/{channel_id}"""
        resp = self._request("GET", f"channels/{channel_id}")
        if resp and resp.status_code == 200:
            return resp.json()
        return None

    def get_dm_channels(self) -> List[Dict[str, Any]]:
        """GET /api/v9/users/@me/channels"""
        resp = self._request("GET", "users/@me/channels")
        if resp and resp.status_code == 200:
            data = resp.json()
            return data if isinstance(data, list) else []
        return []

    def get_relationships(self) -> List[Dict[str, Any]]:
        """GET /api/v9/users/@me/relationships"""
        resp = self._request("GET", "users/@me/relationships")
        if resp and resp.status_code == 200:
            data = resp.json()
            return data if isinstance(data, list) else []
        return []

    def get_user_guilds(self) -> List[Dict[str, Any]]:
        """GET /api/v9/users/@me/guilds"""
        resp = self._request("GET", "users/@me/guilds")
        if resp and resp.status_code == 200:
            data = resp.json()
            return data if isinstance(data, list) else []
        return []

    def search_guild_members(self, guild_id: str, query: str, limit: int = 10) -> List[Dict[str, Any]]:
        """GET /api/v9/guilds/{guild_id}/members/search?query={query}&limit={limit}"""
        resp = self._request(
            "GET",
            f"guilds/{guild_id}/members/search",
            params={"query": query, "limit": min(max(1, limit), 1000)},
        )
        if resp and resp.status_code == 200:
            data = resp.json()
            return data if isinstance(data, list) else []
        return []

    @staticmethod
    def _matches_username(user_obj: Dict[str, Any], target_username: str) -> bool:
        """Check whether a Discord user object matches a target username or tag."""
        if not isinstance(user_obj, dict):
            return False
        needle = target_username.strip().lstrip("@").lower()
        uname = (user_obj.get("username") or "").lower()
        disc = str(user_obj.get("discriminator") or "0")
        gname = (user_obj.get("global_name") or "").lower()

        if "#" in needle:
            return f"{uname}#{disc}" == needle
        return uname == needle or (gname and gname == needle)

    def resolve_username_to_id(self, username: str) -> Optional[Dict[str, Any]]:
        """
        Resolve a Discord username (e.g., 'alex' or 'alex#1234') to a User ID
        by checking open DM channels, relationships, and shared guild member search.
        """
        clean_name = username.strip().lstrip("@")
        base_query = clean_name.split("#", 1)[0]

        # 1. Check open DM channels
        for ch in self.get_dm_channels():
            for rec in ch.get("recipients", []):
                if self._matches_username(rec, clean_name):
                    return {"user_id": rec["id"], "source": "dm_channels", "user": rec}

        # 2. Check relationships (friends / pending / blocked)
        for rel in self.get_relationships():
            u = rel.get("user", {})
            if self._matches_username(u, clean_name):
                return {"user_id": u["id"], "source": "relationships", "user": u}

        # 3. Search shared guilds
        guilds = self.get_user_guilds()
        for guild in guilds:
            gid = guild.get("id")
            if not gid:
                continue
            members = self.search_guild_members(gid, base_query, limit=10)
            for member in members:
                u = member.get("user", {})
                if self._matches_username(u, clean_name):
                    return {"user_id": u["id"], "source": f"guild:{guild.get('name', gid)}", "user": u}
            time.sleep(0.2)

        return None

    def open_dm_channel(self, user_id: str) -> Dict[str, Any]:
        """
        POST /api/v9/users/@me/channels
        Opens (or retrieves) a DM channel with the target user ID and returns
        the channel object including recipient user metadata.
        """
        headers = {
            "X-Context-Properties": self._build_context_properties("Quickswitcher"),
            "Referer": "https://discord.com/channels/@me",
        }
        payload = {"recipients": [str(user_id)]}
        resp = self._request("POST", "users/@me/channels", json=payload, headers=headers)

        if not resp:
            return {"ok": False, "status_code": None, "error": "No response from Discord API", "data": {}}

        if resp.status_code == 200:
            return {"ok": True, "status_code": 200, "error": None, "data": resp.json()}

        err_msg = resp.text[:250]
        try:
            err_msg = resp.json().get("message", err_msg)
        except Exception:
            pass
        return {"ok": False, "status_code": resp.status_code, "error": err_msg, "data": {}}

    def get_message_request_supplemental_data(self, channel_id: str) -> Optional[Dict[str, Any]]:
        """
        GET /api/v9/users/@me/message-requests/supplemental-data?channel_ids={channel_id}
        Fetches supplemental message-request metadata for a DM channel.
        """
        headers = {"Referer": f"https://discord.com/channels/@me/{channel_id}"}
        params = {"channel_ids": str(channel_id)}
        resp = self._request(
            "GET",
            "users/@me/message-requests/supplemental-data",
            params=params,
            headers=headers,
        )
        if resp and resp.status_code == 200:
            return resp.json()
        return None

    def get_user_profile(
        self,
        user_id: str,
        channel_id: Optional[str] = None,
        profile_type: Optional[str] = "sidebar",
        with_mutual_guilds: bool = True,
        with_mutual_friends: bool = True,
        with_mutual_friends_count: bool = False,
    ) -> Dict[str, Any]:
        """
        GET /api/v9/users/{user_id}/profile
        Fetches extended profile details (bio, pronouns, badges, connected accounts,
        mutual guilds, mutual friends, banner) matching the captured sidebar profile call.
        """
        referer = (
            f"https://discord.com/channels/@me/{channel_id}"
            if channel_id
            else "https://discord.com/channels/@me"
        )
        headers = {"Referer": referer}
        params: Dict[str, str] = {
            "with_mutual_guilds": str(with_mutual_guilds).lower(),
            "with_mutual_friends": str(with_mutual_friends).lower(),
            "with_mutual_friends_count": str(with_mutual_friends_count).lower(),
        }
        if profile_type:
            params["type"] = profile_type

        resp = self._request("GET", f"users/{user_id}/profile", params=params, headers=headers)

        if not resp:
            return {"ok": False, "status_code": None, "error": "No response from profile endpoint", "data": {}}

        if resp.status_code == 200:
            return {"ok": True, "status_code": 200, "error": None, "data": resp.json()}

        err_msg = resp.text[:250]
        try:
            err_msg = resp.json().get("message", err_msg)
        except Exception:
            pass
        return {"ok": False, "status_code": resp.status_code, "error": err_msg, "data": {}}

    def get_channel_messages(self, channel_id: str, limit: int = 10) -> List[Dict[str, Any]]:
        """
        GET /api/v9/channels/{channel_id}/messages?limit={limit}
        Fetches recent messages from the opened DM channel.
        """
        headers = {"Referer": f"https://discord.com/channels/@me/{channel_id}"}
        params = {"limit": min(max(1, limit), 100)}
        resp = self._request("GET", f"channels/{channel_id}/messages", params=params, headers=headers)
        if resp and resp.status_code == 200:
            return resp.json()
        return []

    def lookup_target(
        self,
        target: str,
        fetch_profile: bool = True,
        fetch_supplemental: bool = True,
        fetch_messages: bool = False,
        message_limit: int = 10,
        with_mutual_guilds: bool = True,
        with_mutual_friends: bool = True,
    ) -> Dict[str, Any]:
        """
        Resolve a username, User ID, or DM Channel ID and fetch full profile details:
        1. If target is a username -> resolve username to User ID
        2. POST /users/@me/channels -> open DM channel (or if target was a DM channel ID, resolve recipient)
        3. GET  /users/@me/message-requests/supplemental-data
        4. GET  /users/{id}/profile?type=sidebar&with_mutual_guilds=true&with_mutual_friends=true...
        5. GET  /channels/{channel_id}/messages (optional)
        """
        query = str(target).strip()
        uid = query
        resolved_from = "user_id"
        pre_resolved_user: Dict[str, Any] = {}
        pre_channel_id: Optional[str] = None

        if not query.isdigit():
            print(f"   🔎 Resolving username '{query}' to User ID...")
            match = self.resolve_username_to_id(query)
            if not match:
                return {
                    "query": query,
                    "id": "",
                    "status": "failed",
                    "resolved_from": "username_not_found",
                    "username": query,
                    "global_name": "",
                    "discriminator": "0",
                    "tag": query,
                    "bot": False,
                    "created_at": "",
                    "avatar": "",
                    "avatar_url": "",
                    "public_flags": 0,
                    "bio": "",
                    "pronouns": "",
                    "badges": [],
                    "connected_accounts": [],
                    "mutual_guilds": [],
                    "mutual_friends": [],
                    "dm_channel_id": "",
                    "message_count_sampled": 0,
                    "error": f"Could not resolve username '{query}' in DMs, friends, or shared servers",
                    "raw": {},
                }
            uid = str(match["user_id"])
            resolved_from = match["source"]
            pre_resolved_user = match.get("user", {})
            print(f"   🆔 Resolved '{query}' -> {uid} (via {resolved_from})")

        dm_result = self.open_dm_channel(uid)

        # If numeric ID failed DM creation, check if the user supplied a DM channel ID instead of a User ID
        if not dm_result.get("ok") and query.isdigit():
            ch_info = self.get_channel_info(query)
            if ch_info and ch_info.get("recipients"):
                pre_channel_id = ch_info.get("id")
                uid = str(ch_info["recipients"][0]["id"])
                pre_resolved_user = ch_info["recipients"][0]
                resolved_from = "dm_channel_id"
                dm_result = {"ok": True, "status_code": 200, "error": None, "data": ch_info}
                print(f"   🆔 Input was DM Channel ID {pre_channel_id} -> Recipient User ID: {uid}")

        dm_data = dm_result.get("data", {}) if dm_result.get("ok") else {}
        channel_id = dm_data.get("id") or pre_channel_id

        recipient_user: Dict[str, Any] = dict(pre_resolved_user)
        for recipient in dm_data.get("recipients", []):
            if str(recipient.get("id")) == uid:
                recipient_user = recipient
                break
        if not recipient_user and dm_data.get("recipients"):
            recipient_user = dm_data["recipients"][0]

        supplemental_data = None
        if fetch_supplemental and channel_id:
            supplemental_data = self.get_message_request_supplemental_data(channel_id)

        profile_result: Dict[str, Any] = {"ok": False, "data": {}, "error": None}
        if fetch_profile:
            profile_result = self.get_user_profile(
                uid,
                channel_id=channel_id,
                profile_type="sidebar",
                with_mutual_guilds=with_mutual_guilds,
                with_mutual_friends=with_mutual_friends,
                with_mutual_friends_count=False,
            )

        profile_data = profile_result.get("data", {}) if profile_result.get("ok") else {}
        profile_user = profile_data.get("user", {})
        merged_user = {**recipient_user, **profile_user}

        messages: List[Dict[str, Any]] = []
        if fetch_messages and channel_id:
            messages = self.get_channel_messages(channel_id, limit=message_limit)

        username = merged_user.get("username", "")
        global_name = merged_user.get("global_name") or ""
        discriminator = merged_user.get("discriminator") or "0"
        tag = f"{username}#{discriminator}" if username and discriminator != "0" else username
        avatar_hash = merged_user.get("avatar")

        user_profile_meta = profile_data.get("user_profile", {})
        badges = [
            b.get("id") or b.get("description", "")
            for b in profile_data.get("badges", [])
            if isinstance(b, dict)
        ]
        connected_accounts = [
            f"{acc.get('type')}:{acc.get('name')}"
            for acc in profile_data.get("connected_accounts", [])
            if isinstance(acc, dict)
        ]
        mutual_guilds = [
            f"{g.get('id')}{':' + g.get('nick') if g.get('nick') else ''}"
            for g in profile_data.get("mutual_guilds", [])
            if isinstance(g, dict)
        ]
        mutual_friends = [
            f"{f.get('username')}({f.get('id')})"
            for f in profile_data.get("mutual_friends", [])
            if isinstance(f, dict)
        ]

        resolved = bool(username)
        errors = []
        if not dm_result.get("ok") and dm_result.get("error"):
            errors.append(f"dm_channel({dm_result.get('status_code')}): {dm_result.get('error')}")
        if fetch_profile and not profile_result.get("ok") and profile_result.get("error"):
            errors.append(f"profile({profile_result.get('status_code')}): {profile_result.get('error')}")

        return {
            "query": query,
            "id": uid,
            "status": "resolved" if resolved else "failed",
            "resolved_from": resolved_from,
            "username": username,
            "global_name": global_name,
            "discriminator": discriminator,
            "tag": tag,
            "bot": bool(merged_user.get("bot", False)),
            "created_at": self.snowflake_to_iso(uid),
            "avatar": avatar_hash or "",
            "avatar_url": self.build_avatar_url(uid, avatar_hash, discriminator) if resolved else "",
            "public_flags": merged_user.get("public_flags", 0),
            "bio": user_profile_meta.get("bio", "") or "",
            "pronouns": user_profile_meta.get("pronouns", "") or "",
            "badges": badges,
            "connected_accounts": connected_accounts,
            "mutual_guilds": mutual_guilds,
            "mutual_friends": mutual_friends,
            "dm_channel_id": channel_id or "",
            "message_count_sampled": len(messages),
            "error": " | ".join(errors) if not resolved and errors else "",
            "raw": {
                "dm_channel": dm_data,
                "profile": profile_data,
                "supplemental_data": supplemental_data,
                "messages": messages,
            },
        }

    def lookup_users(
        self,
        targets: Union[str, List[str]],
        delay: float = 1.0,
        fetch_profile: bool = True,
        fetch_supplemental: bool = True,
        fetch_messages: bool = False,
        message_limit: int = 10,
        with_mutual_guilds: bool = True,
        with_mutual_friends: bool = True,
    ) -> Dict[str, Any]:
        """Run lookups across usernames, User IDs, or DM Channel IDs."""
        raw_targets = [targets] if isinstance(targets, str) else list(targets)

        seen = set()
        clean_targets: List[str] = []
        for item in raw_targets:
            val = str(item).strip()
            if val and val not in seen:
                seen.add(val)
                clean_targets.append(val)

        print("\n" + "=" * 60)
        print("🔍 STARTING DISCORD USERNAME & PROFILE LOOKUP")
        print(f"👥 Total Targets: {len(clean_targets)}")
        print(f"⚙️  Profile: {fetch_profile} | Supplemental: {fetch_supplemental} | Messages: {fetch_messages}")
        print("=" * 60)

        results: List[Dict[str, Any]] = []
        resolved_count = 0

        for idx, target in enumerate(clean_targets, start=1):
            print(f"\n[{idx}/{len(clean_targets)}] Looking up target: {target}")
            entry = self.lookup_target(
                target,
                fetch_profile=fetch_profile,
                fetch_supplemental=fetch_supplemental,
                fetch_messages=fetch_messages,
                message_limit=message_limit,
                with_mutual_guilds=with_mutual_guilds,
                with_mutual_friends=with_mutual_friends,
            )
            results.append(entry)

            if entry["status"] == "resolved":
                resolved_count += 1
                display = entry["global_name"] or entry["tag"]
                print(
                    f"   ✅ {entry['tag']} (ID: {entry['id']} | Display: {display}) "
                    f"| Mutual Guilds: {len(entry['mutual_guilds'])} | DM Channel: {entry['dm_channel_id'] or 'N/A'}"
                )
            else:
                print(f"   ❌ Failed: {entry['error'] or 'Unknown error'}")

            if idx < len(clean_targets) and delay > 0:
                time.sleep(delay)

        # Persist any refreshed Cloudflare/Discord cookies after the run
        self.persist_session()

        print("\n" + "=" * 60)
        print(f"🏁 Lookup Complete: {resolved_count}/{len(clean_targets)} resolved")
        print("=" * 60)

        return {
            "results": results,
            "metadata": {
                "looked_up_at": datetime.now(timezone.utc).isoformat(),
                "account_email": self.email,
                "total_requested": len(clean_targets),
                "total_resolved": resolved_count,
                "total_failed": len(clean_targets) - resolved_count,
            },
        }

    def save_data(self, data: Dict[str, Any], label: str = "discord_lookup") -> None:
        """Export gathered lookup payloads to formatted JSON and flattened CSV."""
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        safe_label = "".join(c for c in label if c.isalnum() or c in ("_", "-")) or "lookup"
        safe_email = self.email.replace("@", "_").replace(".", "_") if self.email else "account"

        # 1. Full JSON Export
        json_file = f"lookup_{safe_label}_{safe_email}_{timestamp}.json"
        with open(json_file, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, default=str)
        print(f"\n💾 Complete JSON Dump: {json_file}")

        # 2. Structured Users CSV Export
        results = data.get("results", [])
        if results:
            csv_file = f"lookup_{safe_label}_{safe_email}_{timestamp}.csv"
            flat_rows = []
            for item in results:
                flat_rows.append(
                    {
                        "query": item.get("query", ""),
                        "id": item.get("id", ""),
                        "status": item.get("status", ""),
                        "resolved_from": item.get("resolved_from", ""),
                        "username": item.get("username", ""),
                        "global_name": item.get("global_name", ""),
                        "discriminator": item.get("discriminator", ""),
                        "tag": item.get("tag", ""),
                        "bot": item.get("bot", False),
                        "created_at": item.get("created_at", ""),
                        "avatar": item.get("avatar", ""),
                        "avatar_url": item.get("avatar_url", ""),
                        "public_flags": item.get("public_flags", 0),
                        "bio": item.get("bio", ""),
                        "pronouns": item.get("pronouns", ""),
                        "badges": ",".join(item.get("badges", [])),
                        "connected_accounts": ",".join(item.get("connected_accounts", [])),
                        "mutual_guilds": ",".join(item.get("mutual_guilds", [])),
                        "mutual_friends": ",".join(item.get("mutual_friends", [])),
                        "dm_channel_id": item.get("dm_channel_id", ""),
                        "error": item.get("error", ""),
                    }
                )

            fieldnames = list(flat_rows[0].keys())
            with open(csv_file, "w", newline="", encoding="utf-8") as f:
                writer = csv.DictWriter(f, fieldnames=fieldnames)
                writer.writeheader()
                writer.writerows(flat_rows)
            print(f"💾 Users CSV Dump: {csv_file} ({len(flat_rows)} entries)")


def load_targets_from_file(filepath: str) -> List[str]:
    """Load Discord usernames or User IDs from a .txt or .csv file."""
    targets: List[str] = []
    if filepath.lower().endswith(".csv"):
        with open(filepath, "r", encoding="utf-8") as f:
            reader = csv.DictReader(f)
            cols = [col.strip().lower() for col in (reader.fieldnames or [])]
            preferred_col = None
            for candidate in ("username", "id", "user_id", "target"):
                if candidate in cols:
                    preferred_col = reader.fieldnames[cols.index(candidate)]
                    break
            if preferred_col:
                for row in reader:
                    val = (row.get(preferred_col) or "").strip()
                    if val:
                        targets.append(val)
            else:
                f.seek(0)
                for line in f:
                    val = line.strip().split(",")[0].strip()
                    if val:
                        targets.append(val)
    else:
        with open(filepath, "r", encoding="utf-8") as f:
            for line in f:
                for token in line.replace(",", " ").split():
                    if token:
                        targets.append(token)
    return targets


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Standalone Discord Login, Username Resolver & Profile Lookup via Discord API v9"
    )
    parser.add_argument(
        "--targets",
        "--ids",
        dest="targets",
        nargs="+",
        help="One or more Discord usernames, User IDs, or DM Channel IDs",
    )
    parser.add_argument(
        "--file",
        help="Path to a .txt or .csv file containing Discord usernames or User IDs",
    )
    parser.add_argument(
        "--account-file",
        default="account.json",
        help="Path to account JSON file (default: account.json)",
    )
    parser.add_argument(
        "--no-profile",
        action="store_true",
        help="Skip GET /users/{id}/profile call",
    )
    parser.add_argument(
        "--no-supplemental",
        action="store_true",
        help="Skip GET /users/@me/message-requests/supplemental-data",
    )
    parser.add_argument(
        "--messages",
        action="store_true",
        help="Also fetch recent DM messages from the opened channel",
    )
    parser.add_argument(
        "--message-limit",
        type=int,
        default=10,
        help="Number of DM messages to fetch if --messages is set (default: 10)",
    )
    parser.add_argument(
        "--delay",
        type=float,
        default=1.0,
        help="Seconds to sleep between lookups (default: 1.0)",
    )
    parser.add_argument(
        "--label",
        default="usernames",
        help="Output filename label (default: usernames)",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()

    if not os.path.exists(args.account_file):
        print(
            f"❌ {args.account_file} not found! Ensure it exists with format:\n"
            '[{"email": "...", "password": "...", "token": "", "cookies": {}}]'
        )
        return

    try:
        with open(args.account_file, "r", encoding="utf-8") as f:
            loaded = json.load(f)
    except Exception as exc:
        print(f"❌ Failed reading {args.account_file}: {exc}")
        return

    accounts = [loaded] if isinstance(loaded, dict) else loaded
    if not isinstance(accounts, list) or not accounts:
        print(f"❌ {args.account_file} must contain a JSON object or non-empty list of account objects.")
        return

    targets: List[str] = []
    if args.targets:
        for raw in args.targets:
            targets.extend([part.strip() for part in raw.split(",") if part.strip()])
    if args.file:
        if not os.path.exists(args.file):
            print(f"❌ Input file not found: {args.file}")
            return
        targets.extend(load_targets_from_file(args.file))

    if not targets:
        raw_input = input(
            "\n🔎 Enter Discord username(s), User ID(s), or path to .txt/.csv file: "
        ).strip()
        if not raw_input:
            print("❌ No usernames or IDs provided.")
            return
        if os.path.exists(raw_input):
            targets = load_targets_from_file(raw_input)
        else:
            targets = [part.strip() for part in raw_input.replace(" ", ",").split(",") if part.strip()]

    if not targets:
        print("❌ No valid targets found.")
        return

    for idx, account in enumerate(accounts):
        token = account.get("token")
        email = account.get("email") or account.get("login") or account.get("username")
        password = account.get("password")
        cookies = account.get("cookies") or account.get("cookie")
        installation_id = account.get("installation_id")

        if not token and not (email and password):
            continue

        lookup = DiscordUsernameLookup(
            token=token,
            email=email,
            password=password,
            cookies=cookies,
            installation_id=installation_id,
            account_file=args.account_file,
            account_index=idx,
        )
        if lookup.ensure_authenticated():
            data = lookup.lookup_users(
                targets=targets,
                delay=args.delay,
                fetch_profile=not args.no_profile,
                fetch_supplemental=not args.no_supplemental,
                fetch_messages=args.messages,
                message_limit=args.message_limit,
            )
            lookup.save_data(data, label=args.label)
            break


if __name__ == "__main__":
    main()
