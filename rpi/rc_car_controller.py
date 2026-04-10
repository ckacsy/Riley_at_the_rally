import smbus
import math
import time

# PCA9685 register map
_PCA9685_ADDR = 0x40
_MODE1        = 0x00
_PRESCALE     = 0xFE
_LED0_ON_L    = 0x06  # base; each channel adds 4

# Servo timing constants (µs)
_SERVO_NEUTRAL = 1500  # pulse width for centre/neutral position
_SERVO_RANGE   = 1000  # ±range from neutral (1000 µs → 1000..2000 µs)
_STEER_SCALE   = _SERVO_RANGE / 60  # µs per degree of steering (±30° spans ±500 µs)


class RCCarController:
    def __init__(self, i2c_bus=1, pwm_freq=50, throttle_channel=0, steering_channel=1):
        self.bus = smbus.SMBus(i2c_bus)
        self.pwm_freq = pwm_freq
        self.throttle_channel = throttle_channel
        self.steering_channel = steering_channel
        self._init_pca9685(pwm_freq)

    def _init_pca9685(self, freq):
        """Initialise PCA9685: reset, set PWM frequency, wake up."""
        # Full reset
        self.bus.write_byte_data(_PCA9685_ADDR, _MODE1, 0x00)
        time.sleep(0.005)
        # Read current MODE1, set SLEEP bit before changing prescaler
        old_mode = self.bus.read_byte_data(_PCA9685_ADDR, _MODE1)
        self.bus.write_byte_data(_PCA9685_ADDR, _MODE1, (old_mode & 0x7F) | 0x10)
        # Prescaler formula from PCA9685 datasheet: floor(25 MHz / (4096 × freq)) − 1
        prescale = max(3, int(math.floor(25_000_000.0 / (4096.0 * freq))) - 1)
        self.bus.write_byte_data(_PCA9685_ADDR, _PRESCALE, prescale)
        # Restore MODE1 (clears SLEEP)
        self.bus.write_byte_data(_PCA9685_ADDR, _MODE1, old_mode)
        time.sleep(0.005)
        # Set RESTART bit to apply new prescaler
        self.bus.write_byte_data(_PCA9685_ADDR, _MODE1, old_mode | 0x80)

    def set_pwm(self, channel, pulse_us):
        """Set PWM pulse width in microseconds (1000–2000 µs) for *channel*."""
        # Convert µs to 12-bit count for the configured frequency
        count = int(pulse_us * 4096 * self.pwm_freq / 1_000_000)
        count = max(0, min(4095, count))
        base = _LED0_ON_L + 4 * channel
        self.bus.write_byte_data(_PCA9685_ADDR, base,     0)                    # ON_L
        self.bus.write_byte_data(_PCA9685_ADDR, base + 1, 0)                    # ON_H
        self.bus.write_byte_data(_PCA9685_ADDR, base + 2, count & 0xFF)         # OFF_L
        self.bus.write_byte_data(_PCA9685_ADDR, base + 3, (count >> 8) & 0x0F) # OFF_H

    def speed_to_pwm(self, speed):
        """Map speed (-100..100) → servo pulse width (1000–2000 µs).

        Neutral (stopped) = _SERVO_NEUTRAL = 1500 µs.
        Full forward      = 1500 + _SERVO_RANGE/2 = 2000 µs.
        Full reverse      = 1500 − _SERVO_RANGE/2 = 1000 µs.
        """
        speed = max(-100, min(100, speed))
        return int(speed * (_SERVO_RANGE / 200) + _SERVO_NEUTRAL)

    def angle_to_pwm(self, angle):
        """Map steering angle (-30..30°) → servo pulse width (1000–2000 µs).

        Centre (straight) = _SERVO_NEUTRAL = 1500 µs.
        Full left  (−30°) = 1000 µs.
        Full right (+30°) = 2000 µs.
        """
        angle = max(-30, min(30, angle))
        return int(angle * _STEER_SCALE + _SERVO_NEUTRAL)

    def set_throttle(self, speed):
        self.set_pwm(self.throttle_channel, self.speed_to_pwm(speed))

    def set_steering(self, angle):
        self.set_pwm(self.steering_channel, self.angle_to_pwm(angle))

    def stop(self):
        self.set_throttle(0)
        self.set_steering(0)

    def move_forward(self):
        self.set_throttle(100)

    def move_backward(self):
        self.set_throttle(-100)

    def turn_left(self):
        self.set_steering(-30)

    def turn_right(self):
        self.set_steering(30)

    def drive_command(self, speed, angle):
        self.set_throttle(speed)
        self.set_steering(angle)
