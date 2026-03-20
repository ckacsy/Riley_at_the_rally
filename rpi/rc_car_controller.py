import smbus
import time

class RCCarController:
    def __init__(self, i2c_bus=1, pwm_freq=60, throttle_channel=0, steering_channel=1):
        self.bus = smbus.SMBus(i2c_bus)
        self.pwm_freq = pwm_freq
        self.throttle_channel = throttle_channel
        self.steering_channel = steering_channel
        self.set_pwm_freq(self.pwm_freq)

    def set_pwm_freq(self, freq):
        prescaleval = 25000000.0  # 25MHz 
        prescaleval /= 4096.0  # 12 bits
        prescaleval /= freq
        prescaleval -= 1
        prescale = int(prescaleval + 0.5) 
        # Set the PWM frequency
        self.bus.write_byte_data(0x40, 0xFE, prescale)

    def set_throttle(self, speed):
        pulse_width = self.speed_to_pwm(speed)
        self.set_pwm(self.throttle_channel, pulse_width)

    def set_steering(self, angle):
        pulse_width = self.angle_to_pwm(angle)
        self.set_pwm(self.steering_channel, pulse_width)

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

    def speed_to_pwm(self, speed):
        # Convert speed to PWM value (1000-2000μs range)
        pulse_width = int((speed + 100) * 0.005 + 1500)
        return pulse_width

    def angle_to_pwm(self, angle):
        # Convert angle to PWM value (1000-2000μs range)
        pulse_width = int((angle + 30) * (1000 / 60) + 1500)
        return pulse_width

    def set_pwm(self, channel, pulse_width):
        # Set the PWM signal on the given channel with the pulse width
        self.bus.write_byte_data(0x40, 0x06 + 4 * channel, 0)
        self.bus.write_byte_data(0x40, 0x07 + 4 * channel, pulse_width)
