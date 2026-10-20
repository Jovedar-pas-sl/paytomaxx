import { Module } from '@nestjs/common';
import { VenueSectionsController } from './venue-sections.controller';
import { VenueSettingsController } from './venue-settings.controller';
import { VenuesController } from './venues.controller';

@Module({
  controllers: [VenuesController, VenueSettingsController, VenueSectionsController],
})
export class VenuesModule {}
