/**
 * A small check against the passwords attackers try first. Only entries of at
 * least the minimum length matter, since shorter ones are already refused. It
 * is a floor, not a strength meter: the real defence is argon2id and the throttle.
 */
const COMMON = new Set([
	"password1234",
	"password12345",
	"password123456",
	"passwordpassword",
	"123456789012",
	"1234567890123",
	"12345678901234",
	"123456123456",
	"123123123123",
	"111111111111",
	"000000000000",
	"qwertyuiop12",
	"qwertyuiop123",
	"qwertyuiop1234",
	"qwertyuiopasdf",
	"qwerty123456",
	"qwertyqwerty",
	"1q2w3e4r5t6y",
	"1qaz2wsx3edc",
	"asdfghjkl123",
	"zxcvbnm12345",
	"iloveyou1234",
	"letmein12345",
	"welcome12345",
	"administrator",
	"admin1234567",
	"changeme1234",
	"correcthorsebatterystaple",
	"trustno11234",
	"football1234",
	"baseball1234",
	"superman1234",
	"mfwpassword1",
]);

/** Lower-cased, ignoring spaces and separators. */
export function isCommonPassword(password: string): boolean {
	const plain = password.toLowerCase().replace(/[\s_.-]+/g, "");
	if (COMMON.has(plain)) return true;
	// One short unit repeated: "aaaaaaaaaaaa", "abababababab", "abcabcabcabc".
	return /^(.{1,4})\1+$/su.test(plain);
}
