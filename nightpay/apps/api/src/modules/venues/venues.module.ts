import { Module } from '@nestjs/common';
import { VenueSettingsController } from './venue-settings.controller';
import { VenuesController } from './venues.controller';

@Module({
  controllers: [VenuesController, VenueSettingsController],
})
export class VenuesModule {}
